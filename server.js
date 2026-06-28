require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');

const authRoutes = require('./routes/auth');
const projectRoutes = require('./routes/projects');
const tableRoutes = require('./routes/tables');
const apiRoutes = require('./routes/apis');
const runtimeEngine = require('./routes/runtime');

const app = express();

// ─── CORS ──────────────────────────────────────────────────────────────────
// Allows cross-origin requests with cookies (needed for end-user HTML files
// hosted on GitHub Pages, Netlify, Live Server etc.)
app.use(cors({
  origin: true,
  credentials: true,
}));

// ─── MIDDLEWARE ────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ─── STATIC FILES (Platform UI) ───────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── PLATFORM API ROUTES ──────────────────────────────────────────────────
app.use('/auth', authRoutes);
app.use('/projects', projectRoutes);
app.use('/projects/:projectId/tables', tableRoutes);
app.use('/projects/:projectId/apis', apiRoutes);

// ─── RUNTIME ENGINE ───────────────────────────────────────────────────────
// Must come AFTER all platform routes so /:username/:projectname/:apiname
// does not shadow /auth, /projects etc.
app.use('/api', runtimeEngine);

// ─── 404 FALLBACK ─────────────────────────────────────────────────────────
app.use((req, res) => {
  if (req.accepts('html')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.status(404).json({ error: 'Not found.' });
  }
});

// ─── ERROR HANDLER ────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error.' });
});

// ─── START ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ApiForge running on http://localhost:${PORT}`);
});
