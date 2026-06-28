const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

const router = express.Router();

// ─── Helper: log API call ──────────────────────────────────────────────────
async function logCall(apiDefId, projectId, statusCode, ip, method) {
  try {
    await pool.query(
      `INSERT INTO api_logs (api_definition_id, project_id, status_code, ip_address, method)
       VALUES ($1, $2, $3, $4, $5)`,
      [apiDefId || null, projectId || null, statusCode, ip, method]
    );
  } catch (_) {
    // Non-critical — don't crash the response if logging fails
  }
}

// ─── Helper: verify project-level auth cookie ──────────────────────────────
function getProjectUserId(req, project) {
  const cookieName = `proj_token_${project.id}`;
  const token = req.cookies && req.cookies[cookieName];
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return decoded.userId;
  } catch {
    return null;
  }
}


// ─── BUILT-IN: POST /:username/:projectname/register ──────────────────────
router.post('/:username/:projectname/register', async (req, res) => {
  const { username, projectname } = req.params;

  try {
    // Look up project
    const projResult = await pool.query(
      `SELECT p.* FROM projects p
       JOIN users u ON u.id = p.user_id
       WHERE u.username = $1 AND p.name = $2`,
      [username, projectname]
    );
    const project = projResult.rows[0];
    if (!project) return res.status(404).json({ error: 'Project not found.' });
    if (!project.auth_enabled) return res.status(403).json({ error: 'Auth is not enabled for this project.' });

    const { auth_table, auth_email_column, auth_password_column, schema_name } = project;
    const email = req.body[auth_email_column];
    const password = req.body[auth_password_column];

    if (!email || !password) {
      return res.status(400).json({ error: `${auth_email_column} and ${auth_password_column} are required.` });
    }

    const hash = await bcrypt.hash(password, 12);

    // Build INSERT with hashed password
    const otherFields = { ...req.body };
    delete otherFields[auth_password_column];
    otherFields[auth_password_column] = hash;

    const keys = Object.keys(otherFields);
    const vals = Object.values(otherFields);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const colNames = keys.join(', ');

    const insertSQL = `INSERT INTO ${schema_name}.${auth_table} (${colNames}) VALUES (${placeholders}) RETURNING id`;
    const insertResult = await pool.query(insertSQL, vals);

    await logCall(null, project.id, 201, req.ip, 'POST');
    return res.status(201).json({ message: 'Registered successfully.', id: insertResult.rows[0].id });
  } catch (err) {
    console.error('Register error:', err);
    if (err.code === '23505') return res.status(409).json({ error: 'Account already exists.' });
    return res.status(500).json({ error: 'Registration failed.' });
  }
});


// ─── BUILT-IN: POST /:username/:projectname/login ─────────────────────────
router.post('/:username/:projectname/login', async (req, res) => {
  const { username, projectname } = req.params;

  try {
    const projResult = await pool.query(
      `SELECT p.* FROM projects p
       JOIN users u ON u.id = p.user_id
       WHERE u.username = $1 AND p.name = $2`,
      [username, projectname]
    );
    const project = projResult.rows[0];
    if (!project) return res.status(404).json({ error: 'Project not found.' });
    if (!project.auth_enabled) return res.status(403).json({ error: 'Auth is not enabled for this project.' });

    const { auth_table, auth_email_column, auth_password_column, schema_name } = project;
    const email = req.body[auth_email_column];
    const password = req.body[auth_password_column];

    if (!email || !password) {
      return res.status(400).json({ error: `${auth_email_column} and ${auth_password_column} are required.` });
    }

    const userResult = await pool.query(
      `SELECT * FROM ${schema_name}.${auth_table} WHERE ${auth_email_column} = $1`,
      [email]
    );
    const user = userResult.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials.' });

    const match = await bcrypt.compare(password, user[auth_password_column]);
    if (!match) return res.status(401).json({ error: 'Invalid credentials.' });

    const token = jwt.sign(
      { userId: user.id, projectId: project.id },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Set cookie named per project so multiple projects don't conflict
    const cookieName = `proj_token_${project.id}`;
    res.cookie(cookieName, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    await logCall(null, project.id, 200, req.ip, 'POST');
    return res.json({ message: 'Logged in.' });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Login failed.' });
  }
});


// ─── BUILT-IN: POST /:username/:projectname/logout ────────────────────────
router.post('/:username/:projectname/logout', async (req, res) => {
  const { username, projectname } = req.params;
  try {
    const projResult = await pool.query(
      `SELECT p.id FROM projects p JOIN users u ON u.id = p.user_id
       WHERE u.username = $1 AND p.name = $2`,
      [username, projectname]
    );
    const project = projResult.rows[0];
    if (project) {
      res.clearCookie(`proj_token_${project.id}`, { httpOnly: true, sameSite: 'strict' });
    }
    return res.json({ message: 'Logged out.' });
  } catch {
    return res.json({ message: 'Logged out.' });
  }
});


// ─── RUNTIME ENGINE: /:username/:projectname/:apiname ─────────────────────
router.all('/:username/:projectname/:apiname', async (req, res) => {
  const { username, projectname, apiname } = req.params;
  const method = req.method.toUpperCase();

  let project = null;
  let apiDef = null;

  try {
    // 1. Resolve the API definition
    const apiResult = await pool.query(
      `SELECT ad.*, p.schema_name, p.id AS project_id, p.auth_enabled, p.api_key,
              p.auth_table, p.auth_email_column, p.auth_password_column
       FROM api_definitions ad
       JOIN projects p ON ad.project_id = p.id
       JOIN users u ON p.user_id = u.id
       WHERE u.username = $1
         AND p.name = $2
         AND ad.api_name = $3
         AND ad.method = $4`,
      [username, projectname, apiname, method]
    );

    apiDef = apiResult.rows[0];
    if (!apiDef) {
      return res.status(404).json({ error: `No ${method} API named "${apiname}" found in project "${projectname}".` });
    }

    project = { id: apiDef.project_id, schema_name: apiDef.schema_name, auth_enabled: apiDef.auth_enabled, api_key: apiDef.api_key };

    // 2. Auth-off: validate API key from header
    if (!project.auth_enabled) {
      const incomingKey = req.headers['x-api-key'];
      if (!incomingKey || incomingKey !== project.api_key) {
        await logCall(apiDef.id, project.id, 401, req.ip, method);
        return res.status(401).json({ error: 'Invalid or missing API key. Include x-api-key header.' });
      }
    }

    // 3. Auth-on: check requires_auth
    let tokenUserId = null;
    if (apiDef.requires_auth) {
      tokenUserId = getProjectUserId(req, project);
      if (!tokenUserId) {
        await logCall(apiDef.id, project.id, 401, req.ip, method);
        return res.status(401).json({ error: 'Authentication required. Please log in first.' });
      }
    }

    // 4. Build and execute the SQL query
    const schema = apiDef.schema_name;
    const table = apiDef.target_table;
    let result;

    if (method === 'GET') {
      if (apiDef.where_column) {
        let whereVal;
        if (apiDef.where_column === ':token_user_id') {
          whereVal = tokenUserId;
        } else {
          whereVal = req.query[apiDef.where_column];
        }
        result = await pool.query(
          `SELECT * FROM ${schema}.${table} WHERE ${apiDef.where_column === ':token_user_id' ? 'id' : apiDef.where_column} = $1`,
          [whereVal]
        );
      } else {
        result = await pool.query(`SELECT * FROM ${schema}.${table}`);
      }
      await logCall(apiDef.id, project.id, 200, req.ip, method);
      return res.json(result.rows);
    }

    if (method === 'POST') {
      const cols = apiDef.insert_columns;
      if (!cols || cols.length === 0) {
        return res.status(500).json({ error: 'No insert columns configured for this API.' });
      }
      const vals = cols.map(col => req.body[col]);
      const colList = cols.join(', ');
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');

      result = await pool.query(
        `INSERT INTO ${schema}.${table} (${colList}) VALUES (${placeholders}) RETURNING *`,
        vals
      );
      await logCall(apiDef.id, project.id, 201, req.ip, method);
      return res.status(201).json(result.rows[0]);
    }

    if (method === 'PUT') {
      const cols = apiDef.update_columns;
      if (!cols || cols.length === 0) {
        return res.status(500).json({ error: 'No update columns configured for this API.' });
      }

      let whereVal;
      if (apiDef.where_column === ':token_user_id') {
        whereVal = tokenUserId;
      } else {
        whereVal = req.body[apiDef.where_column] || req.query[apiDef.where_column];
      }

      const setClause = cols.map((col, i) => `${col} = $${i + 1}`).join(', ');
      const vals = cols.map(col => req.body[col]);
      vals.push(whereVal);
      const whereCol = apiDef.where_column === ':token_user_id' ? 'id' : apiDef.where_column;

      result = await pool.query(
        `UPDATE ${schema}.${table} SET ${setClause} WHERE ${whereCol} = $${vals.length} RETURNING *`,
        vals
      );
      await logCall(apiDef.id, project.id, 200, req.ip, method);
      return res.json(result.rows[0] || { message: 'No rows updated.' });
    }

    if (method === 'DELETE') {
      let whereVal;
      if (apiDef.where_column === ':token_user_id') {
        whereVal = tokenUserId;
      } else {
        whereVal = req.query[apiDef.where_column] || req.body[apiDef.where_column];
      }
      const whereCol = apiDef.where_column === ':token_user_id' ? 'id' : apiDef.where_column;

      result = await pool.query(
        `DELETE FROM ${schema}.${table} WHERE ${whereCol} = $1 RETURNING *`,
        [whereVal]
      );
      await logCall(apiDef.id, project.id, 200, req.ip, method);
      return res.json({ message: 'Deleted.', deleted: result.rows[0] || null });
    }

    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (err) {
    console.error('Runtime engine error:', err);
    if (project && apiDef) {
      await logCall(apiDef.id, project.id, 500, req.ip, method);
    }
    return res.status(500).json({ error: 'API execution failed.', detail: err.message });
  }
});

module.exports = router;
