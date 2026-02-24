const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// --- Database setup ---
const db = new Database('purim.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    class TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS wins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER REFERENCES students(id),
    item_id INTEGER REFERENCES items(id),
    student_name TEXT,
    item_name TEXT,
    class TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    packed INTEGER DEFAULT 0
  );
`);

// --- Middleware ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Page routes ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/pack', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pack.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// --- Students API ---
app.get('/api/students', (req, res) => {
  const students = db.prepare('SELECT * FROM students ORDER BY class, name').all();
  res.json(students);
});

app.post('/api/students', (req, res) => {
  const { name, class: cls } = req.body;
  if (!name || !cls) return res.status(400).json({ error: 'שם וכיתה נדרשים' });
  const result = db.prepare('INSERT INTO students (name, class) VALUES (?, ?)').run(name.trim(), cls.trim());
  res.json({ id: result.lastInsertRowid, name: name.trim(), class: cls.trim() });
});

app.delete('/api/students/:id', (req, res) => {
  db.prepare('DELETE FROM students WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// --- Items API ---
app.get('/api/items', (req, res) => {
  const items = db.prepare('SELECT * FROM items ORDER BY name').all();
  res.json(items);
});

app.post('/api/items', (req, res) => {
  const { name, quantity } = req.body;
  if (!name) return res.status(400).json({ error: 'שם נדרש' });
  const qty = parseInt(quantity) || 0;
  const result = db.prepare('INSERT INTO items (name, quantity) VALUES (?, ?)').run(name.trim(), qty);
  res.json({ id: result.lastInsertRowid, name: name.trim(), quantity: qty });
});

app.put('/api/items/:id', (req, res) => {
  const { name, quantity } = req.body;
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'לא נמצא' });
  const newName = name !== undefined ? name.trim() : item.name;
  const newQty = quantity !== undefined ? parseInt(quantity) : item.quantity;
  db.prepare('UPDATE items SET name = ?, quantity = ? WHERE id = ?').run(newName, newQty, req.params.id);
  res.json({ id: parseInt(req.params.id), name: newName, quantity: newQty });
});

app.delete('/api/items/:id', (req, res) => {
  db.prepare('DELETE FROM items WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// --- Spin API ---
app.post('/api/spin', (req, res) => {
  const { student_name, student_id } = req.body;

  // Get available items
  const availableItems = db.prepare('SELECT * FROM items WHERE quantity > 0').all();
  if (availableItems.length === 0) return res.status(400).json({ error: 'אין ממתקים במלאי' });

  // Pick random item
  const winner = availableItems[Math.floor(Math.random() * availableItems.length)];

  // Get student info
  let studentName = student_name || 'אנונימי';
  let studentClass = '';
  if (student_id) {
    const student = db.prepare('SELECT * FROM students WHERE id = ?').get(student_id);
    if (student) {
      studentName = student.name;
      studentClass = student.class;
    }
  }

  // Deduct inventory
  db.prepare('UPDATE items SET quantity = quantity - 1 WHERE id = ?').run(winner.id);

  // Record win
  const result = db.prepare(
    'INSERT INTO wins (student_id, item_id, student_name, item_name, class) VALUES (?, ?, ?, ?, ?)'
  ).run(student_id || null, winner.id, studentName, winner.name, studentClass);

  const win = {
    id: result.lastInsertRowid,
    student_name: studentName,
    item_name: winner.name,
    class: studentClass,
    item_id: winner.id,
    packed: 0
  };

  // Emit to all clients
  io.emit('new_win', { win });

  res.json({ win, item: winner });
});

// --- Wins API ---
app.get('/api/wins', (req, res) => {
  const wins = db.prepare('SELECT * FROM wins ORDER BY timestamp DESC').all();
  res.json(wins);
});

// Pack a win (with optimistic locking to prevent double-packing)
app.put('/api/wins/:id/pack', (req, res) => {
  const win = db.prepare('SELECT * FROM wins WHERE id = ?').get(req.params.id);
  if (!win) return res.status(404).json({ error: 'לא נמצא' });
  if (win.packed === 1) return res.status(409).json({ error: 'כבר בוצע' });

  db.prepare('UPDATE wins SET packed = 1 WHERE id = ? AND packed = 0').run(req.params.id);

  io.emit('item_packed', { win_id: parseInt(req.params.id) });
  res.json({ ok: true });
});

// --- Stats API ---
app.get('/api/stats', (req, res) => {
  const totalStudents = db.prepare('SELECT COUNT(*) as count FROM students').get().count;
  const totalWins = db.prepare('SELECT COUNT(*) as count FROM wins').get().count;
  const packedWins = db.prepare('SELECT COUNT(*) as count FROM wins WHERE packed = 1').get().count;
  const pendingWins = totalWins - packedWins;
  const playedStudents = db.prepare('SELECT COUNT(DISTINCT student_id) as count FROM wins WHERE student_id IS NOT NULL').get().count;

  res.json({ totalStudents, totalWins, packedWins, pendingWins, playedStudents });
});

// Reset wins
app.post('/api/reset', (req, res) => {
  // Restore inventory from wins
  const wins = db.prepare('SELECT item_id, COUNT(*) as cnt FROM wins GROUP BY item_id').all();
  const restore = db.transaction(() => {
    for (const row of wins) {
      db.prepare('UPDATE items SET quantity = quantity + ? WHERE id = ?').run(row.cnt, row.item_id);
    }
    db.prepare('DELETE FROM wins').run();
  });
  restore();
  res.json({ ok: true });
});

// --- Socket.io ---
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
