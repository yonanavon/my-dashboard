const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// --- Database setup ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS students (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      class TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS wins (
      id SERIAL PRIMARY KEY,
      student_id INTEGER REFERENCES students(id),
      item_id INTEGER REFERENCES items(id),
      student_name TEXT,
      item_name TEXT,
      class TEXT,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      packed INTEGER DEFAULT 0
    );
  `);
}

// --- Middleware ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Page routes ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/pack', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pack.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// --- Students API ---
app.get('/api/students', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM students ORDER BY class, name');
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/students', async (req, res) => {
  const { name, class: cls } = req.body;
  if (!name || !cls) return res.status(400).json({ error: 'שם וכיתה נדרשים' });
  try {
    const result = await pool.query(
      'INSERT INTO students (name, class) VALUES ($1, $2) RETURNING id',
      [name.trim(), cls.trim()]
    );
    res.json({ id: result.rows[0].id, name: name.trim(), class: cls.trim() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/students/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM students WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/students/bulk', async (req, res) => {
  const { students } = req.body;
  if (!Array.isArray(students) || students.length === 0)
    return res.status(400).json({ error: 'נדרשת רשימת תלמידים' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let added = 0;
    for (const s of students) {
      if (!s.name || !s.class) continue;
      const name = s.name.trim();
      const cls = s.class.trim();
      if (!name || !cls) continue;
      const exists = await client.query(
        'SELECT id FROM students WHERE name = $1 AND class = $2',
        [name, cls]
      );
      if (exists.rows.length === 0) {
        await client.query('INSERT INTO students (name, class) VALUES ($1, $2)', [name, cls]);
        added++;
      }
    }
    await client.query('COMMIT');
    res.json({ ok: true, added, total: students.length });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// --- Items API ---
app.get('/api/items', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM items ORDER BY name');
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/items', async (req, res) => {
  const { name, quantity } = req.body;
  if (!name) return res.status(400).json({ error: 'שם נדרש' });
  const qty = parseInt(quantity) || 0;
  try {
    const result = await pool.query(
      'INSERT INTO items (name, quantity) VALUES ($1, $2) RETURNING id',
      [name.trim(), qty]
    );
    res.json({ id: result.rows[0].id, name: name.trim(), quantity: qty });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/items/:id', async (req, res) => {
  const { name, quantity } = req.body;
  try {
    const itemResult = await pool.query('SELECT * FROM items WHERE id = $1', [req.params.id]);
    if (itemResult.rows.length === 0) return res.status(404).json({ error: 'לא נמצא' });
    const item = itemResult.rows[0];
    const newName = name !== undefined ? name.trim() : item.name;
    const newQty = quantity !== undefined ? parseInt(quantity) : item.quantity;
    await pool.query('UPDATE items SET name = $1, quantity = $2 WHERE id = $3', [newName, newQty, req.params.id]);
    res.json({ id: parseInt(req.params.id), name: newName, quantity: newQty });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/items/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM items WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Spin API ---
app.post('/api/spin', async (req, res) => {
  const { student_name, student_id } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const availableResult = await client.query(
      'SELECT * FROM items WHERE quantity > 0 FOR UPDATE'
    );
    if (availableResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'אין ממתקים במלאי' });
    }

    const availableItems = availableResult.rows;
    const winner = availableItems[Math.floor(Math.random() * availableItems.length)];

    let studentName = student_name || 'אנונימי';
    let studentClass = '';
    if (student_id) {
      const studentResult = await client.query('SELECT * FROM students WHERE id = $1', [student_id]);
      if (studentResult.rows.length > 0) {
        studentName = studentResult.rows[0].name;
        studentClass = studentResult.rows[0].class;
      }
    }

    await client.query('UPDATE items SET quantity = quantity - 1 WHERE id = $1', [winner.id]);

    const winResult = await client.query(
      'INSERT INTO wins (student_id, item_id, student_name, item_name, class) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [student_id || null, winner.id, studentName, winner.name, studentClass]
    );

    await client.query('COMMIT');

    const win = {
      id: winResult.rows[0].id,
      student_id: student_id || null,
      student_name: studentName,
      item_name: winner.name,
      class: studentClass,
      item_id: winner.id,
      packed: 0,
    };

    io.emit('new_win', { win });
    res.json({ win, item: winner });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// --- Wins API ---
app.get('/api/wins', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM wins ORDER BY timestamp DESC');
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/wins/pack-bulk', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'נדרשים מזהים' });
  }
  const numIds = ids.map(Number).filter(n => Number.isInteger(n) && n > 0);
  if (numIds.length === 0) {
    return res.status(400).json({ error: 'מזהים לא תקינים' });
  }
  try {
    const result = await pool.query(
      'UPDATE wins SET packed = 1 WHERE id = ANY($1::int[]) AND packed = 0 RETURNING id',
      [numIds]
    );
    const packedIds = result.rows.map(r => r.id);
    for (const id of packedIds) {
      io.emit('item_packed', { win_id: id });
    }
    res.json({ ok: true, packed: packedIds });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/wins/:id/pack', async (req, res) => {
  try {
    const winResult = await pool.query('SELECT * FROM wins WHERE id = $1', [req.params.id]);
    if (winResult.rows.length === 0) return res.status(404).json({ error: 'לא נמצא' });
    if (winResult.rows[0].packed === 1) return res.status(409).json({ error: 'כבר בוצע' });

    await pool.query('UPDATE wins SET packed = 1 WHERE id = $1 AND packed = 0', [req.params.id]);
    io.emit('item_packed', { win_id: parseInt(req.params.id) });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Stats API ---
app.get('/api/stats', async (req, res) => {
  try {
    const [studentsRes, winsRes, packedRes, playedRes] = await Promise.all([
      pool.query('SELECT COUNT(*) AS count FROM students'),
      pool.query('SELECT COUNT(*) AS count FROM wins'),
      pool.query('SELECT COUNT(*) AS count FROM wins WHERE packed = 1'),
      pool.query('SELECT COUNT(DISTINCT student_id) AS count FROM wins WHERE student_id IS NOT NULL'),
    ]);
    const totalWins = parseInt(winsRes.rows[0].count);
    const packedWins = parseInt(packedRes.rows[0].count);
    res.json({
      totalStudents: parseInt(studentsRes.rows[0].count),
      totalWins,
      packedWins,
      pendingWins: totalWins - packedWins,
      playedStudents: parseInt(playedRes.rows[0].count),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Reset wins
app.post('/api/reset', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const winsResult = await client.query('SELECT item_id, COUNT(*) AS cnt FROM wins GROUP BY item_id');
    for (const row of winsResult.rows) {
      await client.query('UPDATE items SET quantity = quantity + $1 WHERE id = $2', [parseInt(row.cnt), row.item_id]);
    }
    await client.query('DELETE FROM wins');
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// --- Socket.io ---
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

// --- Start server ---
initDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
