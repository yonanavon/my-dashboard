const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="he" dir="rtl">
    <head>
      <meta charset="UTF-8">
      <title>דשבורד</title>
      <style>
        body { font-family: Arial, sans-serif; background: #1a1a2e; color: #eee; text-align: center; padding: 50px; }
        h1 { color: #e94560; font-size: 2.5rem; }
        .cards { display: flex; justify-content: center; gap: 20px; margin-top: 40px; flex-wrap: wrap; }
        .card { background: #16213e; border-radius: 12px; padding: 30px 40px; min-width: 150px; }
        .card .number { font-size: 2.5rem; font-weight: bold; color: #e94560; }
        .card .label { margin-top: 8px; color: #aaa; }
        .time { margin-top: 40px; color: #555; font-size: 0.9rem; }
      </style>
    </head>
    <body>
      <h1>דשבורד ניהול</h1>
      <div class="cards">
        <div class="card">
          <div class="number">142</div>
          <div class="label">משתמשים</div>
        </div>
        <div class="card">
          <div class="number">37</div>
          <div class="label">הזמנות היום</div>
        </div>
        <div class="card">
          <div class="number">₪8,450</div>
          <div class="label">הכנסות</div>
        </div>
      </div>
      <div class="time">עודכן: ${new Date().toLocaleString('he-IL')}</div>
    </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
