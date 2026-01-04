// server.js
require("dotenv").config();
const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const path = require("path");
const multer = require("multer");
const bcrypt = require("bcrypt");
const fs = require("fs");

const SALT_ROUNDS = 10;

const app = express();

// If you want to restrict CORS, replace "*" with your GH pages domain.
// For now keep it open.
app.use(cors());
app.use(express.json());

// Serve static files (uploads)
app.use(express.static("public"));

/* =========================
   Ensure uploads dir exists
   ========================= */
const uploadsDir = path.join(__dirname, "public", "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

/* =========================
   MySQL Pool (PROMISE)
   ========================= */
const pool = mysql.createPool({
  host: process.env.DATABASE_HOST,
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME,
  port: Number(process.env.DATABASE_PORT || 3306),
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

/* =========================
   Helpers
   ========================= */
function dbError(res, err, where = "DB") {
  console.error(`${where} error:`, err);
  return res.status(500).json({
    message: "Database error",
    code: err?.code,
  });
}

/* =========================
   Base + Health
   ========================= */
app.get("/", (req, res) => res.json("Backend is running"));

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1 AS ok");
    return res.json({ ok: true, db: true });
  } catch (err) {
    return dbError(res, err, "GET /health");
  }
});

/* =========================
   CATEGORIES CRUD
   Table: categories (id, name)
   ========================= */

// GET all categories
app.get("/categories", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM categories ORDER BY id DESC"
    );
    return res.json(rows);
  } catch (err) {
    return dbError(res, err, "GET /categories");
  }
});

// GET one category
app.get("/categories/:id", async (req, res) => {
  const id = Number(req.params.id);

  try {
    const [rows] = await pool.query("SELECT * FROM categories WHERE id = ?", [
      id,
    ]);
    if (!rows || rows.length === 0)
      return res.status(404).json({ message: "Category not found" });
    return res.json(rows[0]);
  } catch (err) {
    return dbError(res, err, "GET /categories/:id");
  }
});

// POST create category
app.post("/categories", async (req, res) => {
  const { name } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ message: "name is required" });
  }

  try {
    const sql = "INSERT INTO categories (`name`) VALUES (?)";
    const [result] = await pool.execute(sql, [name.trim()]);
    return res.status(201).json({
      message: "Category created",
      id: result.insertId,
    });
  } catch (err) {
    return dbError(res, err, "POST /categories");
  }
});

// PUT update category
app.put("/categories/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { name } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ message: "name is required" });
  }

  try {
    const sql = "UPDATE categories SET `name` = ? WHERE id = ?";
    const [result] = await pool.execute(sql, [name.trim(), id]);

    if (result.affectedRows === 0)
      return res.status(404).json({ message: "Category not found" });

    return res.json({ message: "Category updated" });
  } catch (err) {
    return dbError(res, err, "PUT /categories/:id");
  }
});

// DELETE category
app.delete("/categories/:id", async (req, res) => {
  const id = Number(req.params.id);

  try {
    // Note: will fail if products reference this category (no ON DELETE CASCADE)
    const sql = "DELETE FROM categories WHERE id = ?";
    const [result] = await pool.execute(sql, [id]);

    if (result.affectedRows === 0)
      return res.status(404).json({ message: "Category not found" });

    return res.json({ message: "Category deleted" });
  } catch (err) {
    return dbError(res, err, "DELETE /categories/:id");
  }
});

/* =========================
   PRODUCTS CRUD
   Table: products (id, name, price, category_id, image)
   FK: products.category_id -> categories.id
   ========================= */

// GET all products
app.get("/products", async (req, res) => {
  const sql = `
    SELECT
      p.id,
      p.name,
      p.price,
      p.category_id,
      p.image,
      c.name AS category
    FROM products p
    INNER JOIN categories c ON p.category_id = c.id
    ORDER BY p.id DESC
  `;

  try {
    const [rows] = await pool.query(sql);
    return res.json(rows);
  } catch (err) {
    return dbError(res, err, "GET /products");
  }
});

// GET one product
app.get("/products/:id", async (req, res) => {
  const id = Number(req.params.id);

  const sql = `
    SELECT
      p.id,
      p.name,
      p.price,
      p.category_id,
      p.image,
      c.name AS category
    FROM products p
    INNER JOIN categories c ON p.category_id = c.id
    WHERE p.id = ?
    LIMIT 1
  `;

  try {
    const [rows] = await pool.query(sql, [id]);
    if (!rows || rows.length === 0)
      return res.status(404).json({ message: "Product not found" });
    return res.json(rows[0]);
  } catch (err) {
    return dbError(res, err, "GET /products/:id");
  }
});

// POST create product
app.post("/products", async (req, res) => {
  const { name, price, category_id, image } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ message: "name is required" });
  }
  if (price === undefined || price === null || Number.isNaN(Number(price))) {
    return res
      .status(400)
      .json({ message: "price is required and must be a number" });
  }
  if (!category_id || Number.isNaN(Number(category_id))) {
    return res
      .status(400)
      .json({ message: "category_id is required and must be a number" });
  }

  try {
    // ensure category exists first
    const [catRows] = await pool.query(
      "SELECT id FROM categories WHERE id = ?",
      [Number(category_id)]
    );
    if (!catRows || catRows.length === 0) {
      return res
        .status(400)
        .json({ message: "Invalid category_id (category not found)" });
    }

    const sql =
      "INSERT INTO products (`name`, `price`, `category_id`, `image`) VALUES (?,?,?,?)";
    const [result] = await pool.execute(sql, [
      name.trim(),
      Number(price),
      Number(category_id),
      image ?? null,
    ]);

    return res.status(201).json({
      message: "Product created",
      id: result.insertId,
    });
  } catch (err) {
    return dbError(res, err, "POST /products");
  }
});

// PUT update product
app.put("/products/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { name, price, category_id, image } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ message: "name is required" });
  }
  if (price === undefined || price === null || Number.isNaN(Number(price))) {
    return res
      .status(400)
      .json({ message: "price is required and must be a number" });
  }
  if (!category_id || Number.isNaN(Number(category_id))) {
    return res
      .status(400)
      .json({ message: "category_id is required and must be a number" });
  }

  try {
    // ensure category exists first
    const [catRows] = await pool.query(
      "SELECT id FROM categories WHERE id = ?",
      [Number(category_id)]
    );
    if (!catRows || catRows.length === 0) {
      return res
        .status(400)
        .json({ message: "Invalid category_id (category not found)" });
    }

    const sql = `
      UPDATE products
      SET name = ?, price = ?, category_id = ?, image = ?
      WHERE id = ?
    `;

    const [result] = await pool.execute(sql, [
      name.trim(),
      Number(price),
      Number(category_id),
      image ?? null,
      id,
    ]);

    if (result.affectedRows === 0)
      return res.status(404).json({ message: "Product not found" });

    return res.json({ message: "Product updated" });
  } catch (err) {
    return dbError(res, err, "PUT /products/:id");
  }
});

// DELETE product
app.delete("/products/:id", async (req, res) => {
  const id = Number(req.params.id);

  try {
    const [result] = await pool.execute("DELETE FROM products WHERE id = ?", [
      id,
    ]);
    if (result.affectedRows === 0)
      return res.status(404).json({ message: "Product not found" });
    return res.json({ message: "Product deleted" });
  } catch (err) {
    return dbError(res, err, "DELETE /products/:id");
  }
});

/* =========================
   USERS CRUD + AUTH
   Table: users (id, name, email, password, is_admin, created_at, updated_at)
   ========================= */

// GET all users (no passwords)
app.get("/users", async (req, res) => {
  const sql =
    "SELECT id, name, email, is_admin, created_at, updated_at FROM users ORDER BY id DESC";

  try {
    const [rows] = await pool.query(sql);
    return res.json(rows);
  } catch (err) {
    return dbError(res, err, "GET /users");
  }
});

// GET one user by id (no password)
app.get("/users/:id", async (req, res) => {
  const id = Number(req.params.id);
  const sql =
    "SELECT id, name, email, is_admin, created_at, updated_at FROM users WHERE id = ? LIMIT 1";

  try {
    const [rows] = await pool.query(sql, [id]);
    if (!rows || rows.length === 0)
      return res.status(404).json({ message: "User not found" });
    return res.json(rows[0]);
  } catch (err) {
    return dbError(res, err, "GET /users/:id");
  }
});

// POST create user (hash password)
app.post("/users", async (req, res) => {
  const { name, email, password, is_admin } = req.body;

  if (!name || !email || !password) {
    return res
      .status(400)
      .json({ message: "name, email, and password are required" });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    const sql =
      "INSERT INTO users (`name`, `email`, `password`, `is_admin`) VALUES (?,?,?,?)";

    try {
      const [result] = await pool.execute(sql, [
        name.trim(),
        email.trim(),
        hashedPassword,
        is_admin ? 1 : 0,
      ]);

      const user = {
        id: result.insertId,
        name: name.trim(),
        email: email.trim(),
        is_admin: is_admin ? 1 : 0,
      };

      return res.status(201).json({
        message: "User created",
        user,
      });
    } catch (err) {
      if (err?.code === "ER_DUP_ENTRY") {
        return res.status(409).json({ message: "Email already exists" });
      }
      return dbError(res, err, "POST /users");
    }
  } catch (err) {
    console.error("Password hashing failed:", err);
    return res.status(500).json({ message: "Password hashing failed" });
  }
});

// PUT update user (hash password)
app.put("/users/:id", async (req, res) => {
  const { name, email, password, is_admin } = req.body;
  const id = Number(req.params.id);

  if (!name || !email || !password) {
    return res
      .status(400)
      .json({ message: "name, email, and password are required" });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    const sql = `
      UPDATE users
      SET name = ?, email = ?, password = ?, is_admin = ?
      WHERE id = ?
    `;

    const [result] = await pool.execute(sql, [
      name.trim(),
      email.trim(),
      hashedPassword,
      is_admin ? 1 : 0,
      id,
    ]);

    if (result.affectedRows === 0)
      return res.status(404).json({ message: "User not found" });

    return res.json({ message: "User updated" });
  } catch (err) {
    return dbError(res, err, "PUT /users/:id");
  }
});

// DELETE user
app.delete("/users/:id", async (req, res) => {
  const id = Number(req.params.id);

  try {
    const [result] = await pool.execute("DELETE FROM users WHERE id = ?", [id]);
    if (result.affectedRows === 0)
      return res.status(404).json({ message: "User not found" });

    return res.json({ message: "User deleted" });
  } catch (err) {
    return dbError(res, err, "DELETE /users/:id");
  }
});

// LOGIN
app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password)
    return res.status(400).json({ message: "email and password are required" });

  try {
    const sql = "SELECT * FROM users WHERE email = ? LIMIT 1";
    const [rows] = await pool.query(sql, [email.trim()]);

    if (!rows || rows.length === 0)
      return res.status(401).json({ message: "Invalid credentials" });

    const user = rows[0];

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ message: "Invalid credentials" });

    // Never send password back
    delete user.password;

    return res.json({
      message: "Login successful",
      user,
    });
  } catch (err) {
    return dbError(res, err, "POST /login");
  }
});

/* =========================
   UPLOAD LOGIC AND ENDPOINT
   ========================= */

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    const safeExt = ext.toLowerCase();
    cb(null, `img_${Date.now()}${safeExt}`);
  },
});

const fileFilter = (req, file, cb) => {
  if (!file.mimetype?.startsWith("image/"))
    return cb(new Error("Only image uploads are allowed"));
  cb(null, true);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

app.post("/upload", upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ message: "No file uploaded" });

  const url = `${req.protocol}://${req.get("host")}/uploads/${
    req.file.filename
  }`;

  return res.status(201).json({
    message: "Uploaded",
    filename: req.file.filename,
    url,
  });
});

/* =========================
   Start server
   ========================= */
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Project backend listening on ${port}`));
