const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('<h1>Hello from Railway!</h1><p>Server is running.</p>');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
