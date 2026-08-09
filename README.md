# ApiForge

> Build dynamic websites without writing a single line of backend code.


ApiForge is a Visual API Builder — a Backend-as-a-Service platform where you create projects, define database tables, and configure REST API endpoints through a UI. Your APIs are instantly live and callable from any HTML file using `fetch()`.

---

## Stack

- **Backend:** Node.js + Express
- **Database:** PostgreSQL (dynamic schema-per-project architecture)
- **Frontend:** Plain HTML + Tailwind CSS
- **Auth:** bcrypt + JWT via HttpOnly cookies

---

## Setup

### 1. Prerequisites

- Node.js v18+
- PostgreSQL 14+

### 2. Create the database

```bash
psql -U postgres -c "CREATE DATABASE apiforge;"
psql -U postgres -d apiforge -f db/init.sql
```

### 3. Configure environment

```bash
cp .env.example .env
# Edit .env with your PostgreSQL credentials and a strong JWT_SECRET
```

### 4. Install dependencies

```bash
npm install
```

### 5. Run

```bash
# Development (auto-restart)
npm run dev

# Production
npm start
```

Open `http://localhost:3000` in your browser.

---

## How it works

### For platform users (you)

1. Register/login at `http://localhost:3000`
2. Create a project (choose auth on or off)
3. Define tables with columns (text, integer, boolean, timestamptz)
4. Define API endpoints — give each one a name, method, target table, and conditions
5. Your APIs are live at `/api/{username}/{project}/{api-name}`

### For end users (people using your HTML frontend)

**Auth OFF** — call APIs with your API key:
```js
fetch('/api/john/myblog/get-all-posts', {
  headers: { 'x-api-key': 'af_...' }
})
```

**Auth ON** — register, login, then call protected APIs:
```js
// Login (sets HttpOnly cookie)
await fetch('/api/john/myblog/login', {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'user@example.com', password: 'secret' })
});

// Protected API (cookie sent automatically)
const res = await fetch('/api/john/myblog/my-posts', {
  credentials: 'include'
});
```

No Node.js. No servers. Just an HTML file opened in a browser or hosted on GitHub Pages / Netlify.

---

## API Reference

### Platform APIs

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/auth/register` | Create platform account |
| POST | `/auth/login` | Login to platform |
| POST | `/auth/logout` | Logout |
| GET | `/auth/me` | Get current user |
| GET | `/projects` | List your projects |
| POST | `/projects` | Create a project |
| GET | `/projects/:id` | Get project details |
| DELETE | `/projects/:id` | Delete a project |
| GET | `/projects/:id/tables` | List tables |
| POST | `/projects/:id/tables` | Create a table |
| DELETE | `/projects/:id/tables/:tid` | Delete a table |
| GET | `/projects/:id/apis` | List API definitions |
| POST | `/projects/:id/apis` | Create an API definition |
| DELETE | `/projects/:id/apis/:aid` | Delete an API definition |

### Runtime (user-defined APIs)

```
/api/{username}/{projectname}/{apiname}
```

Built-in (auth ON projects):
```
POST /api/{username}/{projectname}/register
POST /api/{username}/{projectname}/login
POST /api/{username}/{projectname}/logout
```

---

## Database Architecture

```
PostgreSQL
├── public schema          ← Platform meta-tables
│   ├── users
│   ├── projects
│   ├── project_tables
│   ├── table_columns
│   ├── api_definitions
│   └── api_logs
│
├── proj_1_myblog schema   ← User's project (isolated)
│   ├── blogs
│   └── comments
│
└── proj_2_portfolio       ← Another user's project
    └── projects
```

---

## CSE216 Feature Mapping

| Requirement | Implementation |
|-------------|---------------|
| Transactions | Project creation (schema + meta insert, all-or-nothing) |
| Triggers | `trg_stamp_api_log` (auto-timestamp), `trg_reserved_api_names` (data integrity) |
| Stored Procedures | `create_project_schema()`, `drop_project_schema()` |
| Functions | `generate_api_key()`, `validate_identifier()` |
| Complex Queries | `project_api_stats` view (JOIN + aggregation across api_definitions + api_logs) |

---


## Project Structure

```
apiforge/
├── server.js              # Express app entry point
├── db/
│   ├── pool.js            # PostgreSQL connection pool
│   └── init.sql           # Schema, triggers, functions, procedures
├── middleware/
│   └── platformAuth.js    # JWT cookie auth middleware
├── routes/
│   ├── auth.js            # Platform register/login/logout
│   ├── projects.js        # Project CRUD
│   ├── tables.js          # Table CRUD + dynamic DDL
│   ├── apis.js            # API definition CRUD
│   └── runtime.js         # The execution engine
├── utils/
│   └── identifier.js      # SQL identifier sanitization
└── public/
    ├── index.html          # Landing + auth page
    └── pages/
        ├── dashboard.html  # Projects list
        └── project.html    # Project detail (tables + APIs)
```
