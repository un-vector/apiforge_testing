const express = require('express');
const pool = require('../db/pool');
const { requirePlatformAuth } = require('../middleware/platformAuth');
const { assertIdentifier, isPlatformReserved } = require('../utils/identifier');

const router = express.Router({ mergeParams: true });

router.use(requirePlatformAuth);

// Helper: verify project belongs to logged-in user
async function getProject(projectId, userId) {
  const result = await pool.query(
    'SELECT * FROM projects WHERE id = $1 AND user_id = $2',
    [projectId, userId]
  );
  return result.rows[0];
}


// ─── GET /projects/:projectId/tables ──────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const project = await getProject(req.params.projectId, req.platformUser.id);
    if (!project) return res.status(404).json({ error: 'Project not found.' });

    const result = await pool.query(
      `SELECT pt.*, 
        json_agg(
          json_build_object('id', tc.id, 'column_name', tc.column_name, 'data_type', tc.data_type)
          ORDER BY tc.id
        ) FILTER (WHERE tc.id IS NOT NULL) AS columns
       FROM project_tables pt
       LEFT JOIN table_columns tc ON tc.table_id = pt.id
       WHERE pt.project_id = $1
       GROUP BY pt.id
       ORDER BY pt.created_at`,
      [project.id]
    );
    return res.json(result.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch tables.' });
  }
});


// ─── POST /projects/:projectId/tables ─────────────────────────────────────
// Create a table: inserts meta record + runs CREATE TABLE in project schema
router.post('/', async (req, res) => {
  const { table_name, columns } = req.body;
  // columns: [{ column_name, data_type }]

  if (!table_name) return res.status(400).json({ error: 'Table name is required.' });
  if (!Array.isArray(columns) || columns.length === 0) {
    return res.status(400).json({ error: 'At least one column is required.' });
  }

  try {
    assertIdentifier(table_name, 'table name');
    for (const col of columns) {
      assertIdentifier(col.column_name, 'column name');
      if (isPlatformReserved(col.column_name)) {
        return res.status(400).json({ error: `Column name "${col.column_name}" is reserved by the platform.` });
      }
    }
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const ALLOWED_TYPES = ['text', 'integer', 'boolean', 'timestamptz'];
  for (const col of columns) {
    if (!ALLOWED_TYPES.includes(col.data_type)) {
      return res.status(400).json({ error: `Invalid data type "${col.data_type}". Allowed: ${ALLOWED_TYPES.join(', ')}` });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const project = await getProject(req.params.projectId, req.platformUser.id);
    if (!project) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Project not found.' });
    }

    // Insert into project_tables meta table
    const tableResult = await client.query(
      'INSERT INTO project_tables (project_id, table_name) VALUES ($1, $2) RETURNING *',
      [project.id, table_name.toLowerCase()]
    );
    const tableRecord = tableResult.rows[0];

    // Insert each column into table_columns meta table
    for (const col of columns) {
      await client.query(
        'INSERT INTO table_columns (table_id, column_name, data_type) VALUES ($1, $2, $3)',
        [tableRecord.id, col.column_name.toLowerCase(), col.data_type]
      );
    }

    // Build and execute CREATE TABLE in the project's schema
    const pgTypeMap = {
      text: 'TEXT',
      integer: 'INTEGER',
      boolean: 'BOOLEAN',
      timestamptz: 'TIMESTAMPTZ',
    };

    const colDefs = columns
      .map(col => `${col.column_name.toLowerCase()} ${pgTypeMap[col.data_type]}`)
      .join(', ');

    const createSQL = `
      CREATE TABLE ${project.schema_name}.${table_name.toLowerCase()} (
        id SERIAL PRIMARY KEY,
        ${colDefs},
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await client.query(createSQL);

    await client.query('COMMIT');
    return res.status(201).json({ ...tableRecord, columns });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A table with that name already exists in this project.' });
    }
    console.error('Create table error:', err);
    return res.status(500).json({ error: 'Failed to create table.' });
  } finally {
    client.release();
  }
});


// ─── DELETE /projects/:projectId/tables/:tableId ───────────────────────────
router.delete('/:tableId', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const project = await getProject(req.params.projectId, req.platformUser.id);
    if (!project) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Project not found.' });
    }

    const tableResult = await client.query(
      'SELECT * FROM project_tables WHERE id = $1 AND project_id = $2',
      [req.params.tableId, project.id]
    );
    if (!tableResult.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Table not found.' });
    }

    const tableName = tableResult.rows[0].table_name;

    // Drop the actual table from the project schema
    await client.query(
      `DROP TABLE IF EXISTS ${project.schema_name}.${tableName}`
    );

    // Delete meta record (cascades to table_columns)
    await client.query('DELETE FROM project_tables WHERE id = $1', [req.params.tableId]);

    await client.query('COMMIT');
    return res.json({ message: 'Table deleted.' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Delete table error:', err);
    return res.status(500).json({ error: 'Failed to delete table.' });
  } finally {
    client.release();
  }
});

module.exports = router;
