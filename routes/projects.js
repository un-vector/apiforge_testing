const express = require('express');
const pool = require('../db/pool');
const { requirePlatformAuth } = require('../middleware/platformAuth');
const { assertIdentifier } = require('../utils/identifier');

const router = express.Router();

// All project routes require platform login
router.use(requirePlatformAuth);


// ─── GET /projects ─────────────────────────────────────────────────────────
// List all projects for the logged-in user
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, 
        (SELECT COUNT(*) FROM project_tables pt WHERE pt.project_id = p.id) AS table_count,
        (SELECT COUNT(*) FROM api_definitions ad WHERE ad.project_id = p.id) AS api_count
       FROM projects p
       WHERE p.user_id = $1
       ORDER BY p.created_at DESC`,
      [req.platformUser.id]
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('List projects error:', err);
    return res.status(500).json({ error: 'Failed to fetch projects.' });
  }
});


// ─── POST /projects ────────────────────────────────────────────────────────
// Create a new project (transaction: meta insert + schema creation)
router.post('/', async (req, res) => {
  const { name, auth_enabled, auth_table, auth_email_column, auth_password_column } = req.body;

  if (!name) return res.status(400).json({ error: 'Project name is required.' });

  try {
    assertIdentifier(name, 'project name');
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Generate a unique schema name
    const schemaName = `proj_${req.platformUser.id}_${name.toLowerCase()}`;

    // Generate API key using our DB function
    const keyResult = await client.query('SELECT generate_api_key() AS key');
    const apiKey = keyResult.rows[0].key;

    // Insert project record
    const projectResult = await client.query(
      `INSERT INTO projects 
         (user_id, name, schema_name, auth_enabled, auth_table, auth_email_column, auth_password_column, api_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        req.platformUser.id,
        name.toLowerCase(),
        schemaName,
        auth_enabled || false,
        auth_table || null,
        auth_email_column || null,
        auth_password_column || null,
        apiKey,
      ]
    );

    // Create isolated PostgreSQL schema using our stored procedure
    await client.query('CALL create_project_schema($1)', [schemaName]);

    await client.query('COMMIT');
    return res.status(201).json(projectResult.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ error: 'You already have a project with that name.' });
    }
    console.error('Create project error:', err);
    return res.status(500).json({ error: 'Failed to create project.' });
  } finally {
    client.release();
  }
});


// ─── GET /projects/:projectId ──────────────────────────────────────────────
router.get('/:projectId', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM projects WHERE id = $1 AND user_id = $2',
      [req.params.projectId, req.platformUser.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Project not found.' });
    return res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch project.' });
  }
});


// ─── DELETE /projects/:projectId ───────────────────────────────────────────
router.delete('/:projectId', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const proj = await client.query(
      'SELECT * FROM projects WHERE id = $1 AND user_id = $2',
      [req.params.projectId, req.platformUser.id]
    );
    if (!proj.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Project not found.' });
    }

    const schemaName = proj.rows[0].schema_name;

    // Drop the entire user schema (cascade drops all their tables)
    await client.query('CALL drop_project_schema($1)', [schemaName]);

    // Delete project record (cascades to project_tables, api_definitions, api_logs)
    await client.query('DELETE FROM projects WHERE id = $1', [req.params.projectId]);

    await client.query('COMMIT');
    return res.json({ message: 'Project deleted.' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Delete project error:', err);
    return res.status(500).json({ error: 'Failed to delete project.' });
  } finally {
    client.release();
  }
});

module.exports = router;
