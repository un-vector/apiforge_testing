const express = require('express');
const pool = require('../db/pool');
const { requirePlatformAuth } = require('../middleware/platformAuth');

const router = express.Router({ mergeParams: true });
router.use(requirePlatformAuth);

async function getProject(projectId, userId) {
  const result = await pool.query(
    'SELECT * FROM projects WHERE id = $1 AND user_id = $2',
    [projectId, userId]
  );
  return result.rows[0];
}


// ─── GET /projects/:projectId/apis ─────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const project = await getProject(req.params.projectId, req.platformUser.id);
    if (!project) return res.status(404).json({ error: 'Project not found.' });

    // Join with stats view for call counts
    const result = await pool.query(
      `SELECT ad.*, 
        COALESCE(pas.total_calls, 0) AS total_calls,
        pas.last_called,
        COALESCE(pas.error_count, 0) AS error_count
       FROM api_definitions ad
       LEFT JOIN project_api_stats pas ON pas.api_id = ad.id
       WHERE ad.project_id = $1
       ORDER BY ad.created_at`,
      [project.id]
    );
    return res.json(result.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch APIs.' });
  }
});


// ─── POST /projects/:projectId/apis ────────────────────────────────────────
router.post('/', async (req, res) => {
  const {
    api_name, method, target_table,
    where_column, where_source,
    insert_columns, update_columns,
    requires_auth,
  } = req.body;

  if (!api_name || !method || !target_table) {
    return res.status(400).json({ error: 'api_name, method, and target_table are required.' });
  }

  const VALID_METHODS = ['GET', 'POST', 'PUT', 'DELETE'];
  if (!VALID_METHODS.includes(method.toUpperCase())) {
    return res.status(400).json({ error: `Method must be one of: ${VALID_METHODS.join(', ')}` });
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(api_name)) {
    return res.status(400).json({ error: 'API name may only contain letters, digits, underscores, and hyphens.' });
  }

  try {
    const project = await getProject(req.params.projectId, req.platformUser.id);
    if (!project) return res.status(404).json({ error: 'Project not found.' });

    // Verify target_table exists in this project
    const tableCheck = await pool.query(
      'SELECT id FROM project_tables WHERE project_id = $1 AND table_name = $2',
      [project.id, target_table]
    );
    if (!tableCheck.rows[0]) {
      return res.status(400).json({ error: `Table "${target_table}" does not exist in this project.` });
    }

    const result = await pool.query(
      `INSERT INTO api_definitions
         (project_id, api_name, method, target_table, where_column, where_source,
          insert_columns, update_columns, requires_auth)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        project.id,
        api_name.toLowerCase(),
        method.toUpperCase(),
        target_table,
        where_column || null,
        where_source || null,
        insert_columns || null,
        update_columns || null,
        requires_auth || false,
      ]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'An API with that name and method already exists.' });
    }
    // Trigger error for reserved names
    if (err.message && err.message.includes('reserved')) {
      return res.status(400).json({ error: err.message });
    }
    console.error('Create API error:', err);
    return res.status(500).json({ error: 'Failed to create API.' });
  }
});


// ─── DELETE /projects/:projectId/apis/:apiId ───────────────────────────────
router.delete('/:apiId', async (req, res) => {
  try {
    const project = await getProject(req.params.projectId, req.platformUser.id);
    if (!project) return res.status(404).json({ error: 'Project not found.' });

    const result = await pool.query(
      'DELETE FROM api_definitions WHERE id = $1 AND project_id = $2 RETURNING id',
      [req.params.apiId, project.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'API not found.' });
    return res.json({ message: 'API deleted.' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to delete API.' });
  }
});

module.exports = router;
