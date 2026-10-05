import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { calculateCommission } from "./lib/marketplace.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.MARKET_DB_PATH || resolve(root, "data", "salonemarket.sqlite");
mkdirSync(dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
const cookieName = "salonemarket_session";
const loginAttempts = new Map();
const frontendOrigin = process.env.FRONTEND_ORIGIN ? new URL(process.env.FRONTEND_ORIGIN).origin : "";
const mime = { ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

db.exec(`
  PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE COLLATE NOCASE,display_name TEXT NOT NULL,store_name TEXT NOT NULL DEFAULT '',phone TEXT NOT NULL DEFAULT '',fee_percent REAL,role TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'approved',salt TEXT NOT NULL,password_hash TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,last_activity INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY,vendor_id TEXT NOT NULL REFERENCES users(id),title TEXT NOT NULL,description TEXT NOT NULL,category TEXT NOT NULL,price REAL NOT NULL,currency TEXT NOT NULL,stock INTEGER NOT NULL,image TEXT NOT NULL DEFAULT '',active INTEGER NOT NULL DEFAULT 1,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE INDEX IF NOT EXISTS product_vendor_idx ON products(vendor_id,active);
  CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  INSERT OR IGNORE INTO settings VALUES('commission_percent','5');
  CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,customer_id TEXT NOT NULL REFERENCES users(id),customer_name TEXT NOT NULL,email TEXT NOT NULL,phone TEXT NOT NULL,address TEXT NOT NULL,city TEXT NOT NULL,currency TEXT NOT NULL,gross REAL NOT NULL,commission REAL NOT NULL,vendor_net REAL NOT NULL,payment_method TEXT NOT NULL,payment_status TEXT NOT NULL,status TEXT NOT NULL,tx_ref TEXT UNIQUE,free_delivery INTEGER NOT NULL DEFAULT 0,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS order_items(id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES orders(id),product_id TEXT NOT NULL REFERENCES products(id),vendor_id TEXT NOT NULL REFERENCES users(id),title TEXT NOT NULL,quantity INTEGER NOT NULL,unit_price REAL NOT NULL,currency TEXT NOT NULL,commission REAL NOT NULL,vendor_net REAL NOT NULL,fulfillment_status TEXT NOT NULL DEFAULT 'placed');
  CREATE INDEX IF NOT EXISTS order_item_vendor_idx ON order_items(vendor_id,order_id);
  CREATE TABLE IF NOT EXISTS payouts(id TEXT PRIMARY KEY,vendor_id TEXT NOT NULL REFERENCES users(id),amount REAL NOT NULL,currency TEXT NOT NULL,method TEXT NOT NULL,destination TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS contact_messages(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL,topic TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'new',created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS vendor_promotions(user_id TEXT PRIMARY KEY REFERENCES users(id),slot INTEGER NOT NULL UNIQUE,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS delivery_promotions(user_id TEXT PRIMARY KEY REFERENCES users(id),order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),status TEXT NOT NULL CHECK(status IN('reserved','redeemed')),claimed_at INTEGER NOT NULL);
`);
if (!db.prepare("PRAGMA table_info(order_items)").all().some(column => column.name === "fulfillment_status")) db.exec("ALTER TABLE order_items ADD COLUMN fulfillment_status TEXT NOT NULL DEFAULT 'placed'");
function ensureColumn(table, name, definition) { if (!db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`); }
ensureColumn("users", "phone", "TEXT NOT NULL DEFAULT ''");
ensureColumn("users", "fee_percent", "REAL");
ensureColumn("orders", "free_delivery", "INTEGER NOT NULL DEFAULT 0");

function hashPassword(password, salt = randomBytes(16).toString("hex")) { return { salt, hash: scryptSync(password, salt, 64).toString("hex") }; }
if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD && !db.prepare("SELECT 1 FROM users WHERE role='admin'").get()) {
  const email = process.env.ADMIN_EMAIL.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || process.env.ADMIN_PASSWORD.length < 12) throw new Error("Set a valid ADMIN_EMAIL and an ADMIN_PASSWORD of at least 12 characters.");
  const { salt, hash } = hashPassword(process.env.ADMIN_PASSWORD);
  db.prepare("INSERT INTO users(id,email,display_name,role,status,salt,password_hash) VALUES(?,?,?,'admin','approved',?,?)").run(randomUUID(), email, "XD-MARKET Admin", salt, hash);
}

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
function fail(status, message) { throw new HttpError(status, message); }
function json(res, status, value, headers = {}) { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers }); res.end(JSON.stringify(value)); }
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 3_000_000) fail(413, "Request is too large."); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString()); if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, "Invalid request body."); return value; }
  catch (error) { if (error instanceof HttpError) throw error; fail(400, "Invalid JSON."); }
}
function text(value, label, max = 160) { if (typeof value !== "string" || !value.trim() || value.trim().length > max) fail(400, `${label} is required.`); return value.trim(); }
function sameOrigin(req) {
  try {
    const expected = process.env.APP_ORIGIN ? new URL(process.env.APP_ORIGIN).origin : `${req.socket.encrypted ? "https" : "http"}://${req.headers.host}`;
    const origin=req.headers.origin?new URL(req.headers.origin).origin:"";
    if (!origin || (origin !== expected && origin !== frontendOrigin)) fail(403, "Request origin could not be verified.");
  } catch (error) { if (error instanceof HttpError) throw error; fail(403, "Request origin could not be verified."); }
}
function cookie(token, age = 1800) { const crossSite=Boolean(frontendOrigin),secure=process.env.NODE_ENV === "production"||crossSite; return `${cookieName}=${token}; HttpOnly; SameSite=${crossSite?"None":"Strict"}; Path=/; Max-Age=${age}${secure ? "; Secure" : ""}`; }
function userFor(req, res, required = true) {
  const token = (req.headers.cookie || "").split(";").map(item => item.trim()).find(item => item.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  if (!token) { if (required) fail(401, "Sign in to continue."); return null; }
  const key = createHash("sha256").update(token).digest("hex"), session = db.prepare("SELECT user_id,last_activity FROM sessions WHERE token_hash=?").get(key);
  if (!session || Date.now() - session.last_activity >= 1_800_000) { db.prepare("DELETE FROM sessions WHERE token_hash=?").run(key); res.setHeader("Set-Cookie", cookie("", 0)); if (required) fail(401, "Your session expired. Sign in again."); return null; }
  db.prepare("UPDATE sessions SET last_activity=? WHERE token_hash=?").run(Date.now(), key); res.setHeader("Set-Cookie", cookie(token));
  return db.prepare("SELECT id,email,display_name AS displayName,store_name AS storeName,phone,role,status FROM users WHERE id=?").get(session.user_id);
}
function issueSession(res, id) { const token = randomBytes(32).toString("base64url"); db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(createHash("sha256").update(token).digest("hex"), id, Date.now()); res.setHeader("Set-Cookie", cookie(token)); }
function role(user, expected) { if (user.role !== expected) fail(403, "You do not have access to this page."); if (expected === "vendor" && user.status !== "approved") fail(403, "Your seller application is awaiting approval."); }
function fee() { return Number(db.prepare("SELECT value FROM settings WHERE key='commission_percent'").get().value); }
function safeImage(value) { if (!value) return ""; if (typeof value !== "string" || value.length > 2_700_000 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) fail(400, "Use a PNG, JPEG, or WebP photo smaller than 2 MB."); return value; }
function productView(row) { return { id: row.id, vendorId: row.vendor_id, vendor: row.store_name, title: row.title, description: row.description, category: row.category, price: row.price, currency: row.currency, stock: row.stock, image: row.image }; }
function orderView(row, vendorId = null) {
  const items = db.prepare(`SELECT id,product_id AS productId,vendor_id AS vendorId,title,quantity,unit_price AS unitPrice,currency,commission,vendor_net AS vendorNet,fulfillment_status AS status FROM order_items WHERE order_id=?${vendorId ? " AND vendor_id=?" : ""}`).all(...(vendorId ? [row.id, vendorId] : [row.id]));
  const gross = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  const commission = items.reduce((sum, item) => sum + item.commission, 0);
  const vendorNet = items.reduce((sum, item) => sum + item.vendorNet, 0);
  const statuses = [...new Set(items.map(item => item.status))];
  return { id: row.id, customerName: row.customer_name, email: row.email, phone: row.phone, address: row.address, city: row.city, currency: row.currency, gross: vendorId ? gross : row.gross, commission: vendorId ? commission : row.commission, vendorNet: vendorId ? vendorNet : row.vendor_net, freeDelivery: Boolean(row.free_delivery), paymentMethod: row.payment_method, paymentStatus: row.payment_status, status: vendorId ? statuses.length === 1 ? statuses[0] : "in progress" : row.status, createdAt: row.created_at, items };
}
function balance(vendorId, currency) {
  const earned = db.prepare("SELECT COALESCE(SUM(i.vendor_net),0) amount FROM order_items i JOIN orders o ON o.id=i.order_id WHERE i.vendor_id=? AND i.currency=? AND o.payment_status='paid'").get(vendorId, currency).amount;
  const held = db.prepare("SELECT COALESCE(SUM(amount),0) amount FROM payouts WHERE vendor_id=? AND currency=? AND status IN('pending','approved','paid')").get(vendorId, currency).amount;
  return Math.round((earned - held) * 100) / 100;
}
function createOrder(user, input) {
  const name = text(input.name, "Full name", 100), email = text(input.email, "Email", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, "Enter a valid email address.");
  const phone = text(input.phone, "Phone number", 40), address = text(input.address, "Shipping address", 200), city = text(input.city, "City or district", 80), method = text(input.paymentMethod, "Payment method", 40);
  if (!["orange_money", "afrimoney", "card", "bank_transfer", "cash_on_delivery"].includes(method)) fail(400, "Choose a supported payment method.");
  if (method === "cash_on_delivery" && process.env.NODE_ENV === "production") fail(400, "Cash on delivery is not enabled for this store.");
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 40) fail(400, "Your cart is empty or too large.");
  const quantities = new Map();
  for (const item of input.items) { if (!item || typeof item.productId !== "string" || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) fail(400, "Invalid cart item."); quantities.set(item.productId, (quantities.get(item.productId) || 0) + item.quantity); }
  const items = [...quantities].map(([id, quantity]) => {
    const product = db.prepare("SELECT p.*,u.store_name,u.fee_percent FROM products p JOIN users u ON u.id=p.vendor_id WHERE p.id=? AND p.active=1 AND u.status='approved'").get(id);
    if (!product || product.stock < quantity) fail(409, "A product is unavailable or has insufficient stock.");
    return { product, quantity, ...calculateCommission(product.price * quantity, product.fee_percent ?? fee()) };
  });
  if (new Set(items.map(item => item.product.currency)).size !== 1) fail(400, "Checkout items must use the same currency.");
  const currency = items[0].product.currency, gross = items.reduce((sum, item) => sum + item.gross, 0), commission = items.reduce((sum, item) => sum + item.commission, 0), net = items.reduce((sum, item) => sum + item.vendorNet, 0);
  const id = randomUUID(), txRef = method === "cash_on_delivery" ? null : `SM-${id}`;
  db.exec("BEGIN IMMEDIATE");
  try {
    const expiry=Date.now()-30*60*1000;
    db.prepare("UPDATE orders SET free_delivery=0 WHERE id IN(SELECT order_id FROM delivery_promotions WHERE status='reserved' AND claimed_at<?)").run(expiry);
    db.prepare("DELETE FROM delivery_promotions WHERE status='reserved' AND claimed_at<?").run(expiry);
    const hasDeliveryAward=db.prepare("SELECT 1 FROM delivery_promotions WHERE user_id=?").get(user.id);
    const awardCount=db.prepare("SELECT COUNT(*) count FROM delivery_promotions").get().count;
    const freeDelivery=!hasDeliveryAward&&awardCount<5;
    for (const item of items) if (db.prepare("UPDATE products SET stock=stock-? WHERE id=? AND stock>=?").run(item.quantity, item.product.id, item.quantity).changes !== 1) fail(409, "A product just sold out. Refresh and try again.");
    db.prepare("INSERT INTO orders(id,customer_id,customer_name,email,phone,address,city,currency,gross,commission,vendor_net,payment_method,payment_status,status,tx_ref,free_delivery) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, user.id, name, email, phone, address, city, currency, gross, commission, net, method, method === "cash_on_delivery" ? "pending" : "awaiting_payment", "placed", txRef, Number(freeDelivery));
    if(freeDelivery) db.prepare("INSERT INTO delivery_promotions(user_id,order_id,status,claimed_at) VALUES(?,?,?,?)").run(user.id,id,method==="cash_on_delivery"?"redeemed":"reserved",Date.now());
    const add = db.prepare("INSERT INTO order_items(id,order_id,product_id,vendor_id,title,quantity,unit_price,currency,commission,vendor_net) VALUES(?,?,?,?,?,?,?,?,?,?)");
    for (const item of items) add.run(randomUUID(), id, item.product.id, item.product.vendor_id, item.product.title, item.quantity, item.product.price, currency, item.commission, item.vendorNet);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return db.prepare("SELECT * FROM orders WHERE id=?").get(id);
}
async function startFlutterwave(order, req) {
  if (!process.env.FLW_SECRET_KEY) fail(503, "Online payments are not configured. Set FLW_SECRET_KEY to enable checkout.");
  const origin = process.env.APP_ORIGIN || `${req.socket.encrypted ? "https" : "http"}://${req.headers.host}`;
  const options = { orange_money: "mobilemoney_sl", afrimoney: "mobilemoney_sl", card: "card", bank_transfer: "banktransfer" }[order.payment_method];
  const response = await fetch("https://api.flutterwave.com/v3/payments", { method: "POST", headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ tx_ref: order.tx_ref, amount: order.gross.toFixed(2), currency: order.currency, redirect_url: `${origin}/?payment=return`, payment_options: options, customer: { email: order.email, name: order.customer_name, phonenumber: order.phone }, meta: { order_id: order.id, selected_method: order.payment_method }, customizations: { title: "XD-MARKET", description: "Marketplace order" } }) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.status !== "success" || !result.data?.link) fail(502, "The payment provider could not start checkout.");
  return result.data.link;
}
async function verifyCharge(transactionId, txRef) {
  if (!process.env.FLW_SECRET_KEY || !/^\d+$/.test(String(transactionId))) return false;
  const response = await fetch(`https://api.flutterwave.com/v3/transactions/${transactionId}/verify`, { headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}` } });
  const result = await response.json().catch(() => ({})), order = db.prepare("SELECT * FROM orders WHERE tx_ref=?").get(txRef);
  if (!response.ok || result.status !== "success" || !order) return false;
  const data = result.data;
  if (data.status !== "successful" || data.tx_ref !== txRef || data.currency !== order.currency || Number(data.amount) < order.gross) return false;
  db.prepare("UPDATE orders SET payment_status='paid',status=CASE WHEN status='placed' THEN 'processing' ELSE status END WHERE id=? AND payment_status!='paid'").run(order.id);
  db.prepare("UPDATE delivery_promotions SET status='redeemed' WHERE order_id=? AND status='reserved'").run(order.id);
  return true;
}

async function route(req, res) {
  const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const expectedOrigin=process.env.APP_ORIGIN?new URL(process.env.APP_ORIGIN).origin:`${req.socket.encrypted?"https":"http"}://${req.headers.host}`;
  const requestOrigin=req.headers.origin?new URL(req.headers.origin).origin:"";
  const allowedOrigin=requestOrigin&&(requestOrigin===expectedOrigin||requestOrigin===frontendOrigin);
  if(allowedOrigin){res.setHeader("Access-Control-Allow-Origin",requestOrigin);res.setHeader("Access-Control-Allow-Credentials","true");res.setHeader("Vary","Origin");}
  if(req.method==="OPTIONS"){
    if(!allowedOrigin) fail(403,"Request origin could not be verified.");
    res.writeHead(204,{"Access-Control-Allow-Methods":"GET, POST, PATCH, OPTIONS","Access-Control-Allow-Headers":"Content-Type","Access-Control-Max-Age":"600"});return res.end();
  }
  if (req.method === "GET" && path === "/api/store") {
    const products = db.prepare("SELECT p.*,u.store_name FROM products p JOIN users u ON u.id=p.vendor_id WHERE p.active=1 AND p.stock>0 AND u.status='approved' ORDER BY p.created_at DESC").all();
    const vendors = db.prepare("SELECT u.id,u.store_name AS name,u.display_name AS displayName,COUNT(p.id) products FROM users u JOIN products p ON p.vendor_id=u.id AND p.active=1 WHERE u.role='vendor' AND u.status='approved' GROUP BY u.id ORDER BY products DESC LIMIT 6").all();
    const deliveryUsed=db.prepare("SELECT COUNT(*) count FROM delivery_promotions WHERE status='redeemed' OR claimed_at>?").get(Date.now()-30*60*1000).count;
    const vendorUsed=db.prepare("SELECT COUNT(*) count FROM vendor_promotions").get().count;
    return json(res, 200, { products: products.map(productView), vendors, commissionPercent: fee(), promotions:{freeDeliveryRemaining:Math.max(0,5-deliveryUsed),vendorCommissionRemaining:Math.max(0,10-vendorUsed)} });
  }
  if (path.startsWith("/api/") && req.method !== "GET" && path !== "/api/flutterwave/webhook") sameOrigin(req);
  if (req.method === "POST" && path === "/api/contact") {
    const input=await body(req),name=text(input.name,"Name",100),email=text(input.email,"Email",254).toLowerCase(),topic=text(input.topic,"Subject",120),message=text(input.message,"Message",3000);
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400,"Enter a valid email address.");
    db.prepare("INSERT INTO contact_messages(id,name,email,topic,message) VALUES(?,?,?,?,?)").run(randomUUID(),name,email,topic,message);
    return json(res,201,{received:true});
  }
  if (req.method === "GET" && path === "/api/auth/me") return json(res, 200, { user: userFor(req, res, false) });
  if (req.method === "POST" && path === "/api/auth/register") {
    const input = await body(req), roleName = input.role === "buyer" ? "customer" : input.role;
    if (!new Set(["customer", "vendor"]).has(roleName)) fail(400, "Choose buyer or seller registration.");
    const email = text(input.email, "Email", 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, "Enter a valid email address.");
    const phone=text(input.phone,"Phone number",30),phoneDigits=phone.replace(/\D/g,"");
    if(phoneDigits.length<7||phoneDigits.length>15||!/^[+0-9().\s-]+$/.test(phone)) fail(400,"Enter a valid international phone number.");
    if (typeof input.password !== "string" || input.password.length < 12 || input.password.length > 128) fail(400, "Password must be 12–128 characters.");
    const name = text(input.displayName, "Your name", 100), store = roleName === "vendor" ? text(input.storeName, "Store name", 100) : "", id = randomUUID(), { salt, hash } = hashPassword(input.password);
    try { db.prepare("INSERT INTO users(id,email,display_name,store_name,phone,role,status,salt,password_hash) VALUES(?,?,?,?,?,?,?,?,?)").run(id,email,name,store,phone,roleName,roleName === "vendor" ? "pending" : "approved",salt,hash); }
    catch (error) { if (error.code === "SQLITE_CONSTRAINT_UNIQUE") fail(409, "An account with this email already exists."); throw error; }
    issueSession(res,id);
    return json(res,201,{ user: db.prepare("SELECT id,email,display_name AS displayName,store_name AS storeName,phone,role,status FROM users WHERE id=?").get(id) });
  }
  if (req.method === "POST" && path === "/api/auth/login") {
    const input = await body(req), email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "", account = db.prepare("SELECT * FROM users WHERE email=?").get(email);
    const key=`${req.socket.remoteAddress}:${email}`,now=Date.now(),previous=loginAttempts.get(key);
    if(previous?.until>now) fail(429,"Too many attempts. Try again in 15 minutes.");
    const valid = typeof input.password === "string" && input.password.length <= 128 && account && timingSafeEqual(Buffer.from(hashPassword(input.password,account.salt).hash,"hex"),Buffer.from(account.password_hash,"hex"));
    if (!valid) {
      const attempt=previous&&now-previous.started<900_000?previous:{count:0,started:now};
      attempt.count++;if(attempt.count>=5)attempt.until=now+900_000;loginAttempts.set(key,attempt);
      fail(401,"Email or password is incorrect.");
    }
    loginAttempts.delete(key);
    issueSession(res,account.id);
    return json(res,200,{ user:{id:account.id,email:account.email,displayName:account.display_name,storeName:account.store_name,phone:account.phone,role:account.role,status:account.status} });
  }
  if (req.method === "POST" && path === "/api/auth/logout") {
    const token=(req.headers.cookie||"").split(";").map(x=>x.trim()).find(x=>x.startsWith(`${cookieName}=`))?.slice(cookieName.length+1);
    if(token) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(createHash("sha256").update(token).digest("hex"));
    return json(res,200,{ok:true},{"Set-Cookie":cookie("",0)});
  }
  if (req.method === "POST" && path === "/api/orders") {
    const user=userFor(req,res); if(user.role!=="customer") fail(403,"Sign in with a buyer account to place an order.");
    const order=createOrder(user,await body(req));
    if(order.payment_method==="cash_on_delivery") return json(res,201,{order:orderView(order)});
    try { return json(res,201,{order:orderView(order),checkoutUrl:await startFlutterwave(order,req)}); }
    catch(error) {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const item of db.prepare("SELECT product_id,quantity FROM order_items WHERE order_id=?").all(order.id)) db.prepare("UPDATE products SET stock=stock+? WHERE id=?").run(item.quantity,item.product_id);
        db.prepare("DELETE FROM delivery_promotions WHERE order_id=? AND status='reserved'").run(order.id);
        db.prepare("UPDATE orders SET payment_status='payment_setup_failed',free_delivery=0 WHERE id=?").run(order.id);
        db.exec("COMMIT");
      } catch (rollbackError) { db.exec("ROLLBACK"); throw rollbackError; }
      throw error;
    }
  }
  if (req.method === "POST" && path === "/api/flutterwave/webhook") {
    const expected=process.env.FLW_WEBHOOK_SECRET, supplied=req.headers["verif-hash"];
    if(!expected||typeof supplied!=="string"||supplied.length!==expected.length||!timingSafeEqual(Buffer.from(supplied),Buffer.from(expected))) fail(401,"Invalid payment notification.");
    const event=await body(req); if(event.event==="charge.completed"&&event.data?.id&&event.data?.tx_ref) await verifyCharge(event.data.id,event.data.tx_ref);
    return json(res,200,{received:true});
  }
  if(!path.startsWith("/api/")) return serveStatic(path,res);
  const user=userFor(req,res);
  if(req.method==="GET"&&path==="/api/vendor/summary") {
    role(user,"vendor");
    const products=db.prepare("SELECT * FROM products WHERE vendor_id=? AND active=1 ORDER BY created_at DESC").all(user.id);
    const orders=db.prepare("SELECT DISTINCT o.* FROM orders o JOIN order_items i ON i.order_id=o.id WHERE i.vendor_id=? ORDER BY o.created_at DESC").all(user.id).map(order=>orderView(order,user.id));
    const payouts=db.prepare("SELECT id,amount,currency,method,destination,status,created_at AS createdAt FROM payouts WHERE vendor_id=? ORDER BY created_at DESC").all(user.id);
    const currencies=[...new Set([...products.map(x=>x.currency),...orders.map(x=>x.currency),...payouts.map(x=>x.currency)])];
    const vendorFee=db.prepare("SELECT fee_percent FROM users WHERE id=?").get(user.id).fee_percent;
    return json(res,200,{products:products.map(productView),orders,payouts,balances:Object.fromEntries(currencies.map(c=>[c,balance(user.id,c)])),commissionPercent:vendorFee??fee(),promoRate:vendorFee===5});
  }
  if(req.method==="POST"&&path==="/api/vendor/products") {
    role(user,"vendor"); const x=await body(req),price=Number(x.price),stock=Number(x.stock);
    if(!Number.isFinite(price)||price<=0||price>1e9) fail(400,"Enter a valid price.");
    if(!Number.isInteger(stock)||stock<0||stock>1e6) fail(400,"Enter a valid stock quantity.");
    if(!new Set(["SLE","USD"]).has(x.currency)) fail(400,"Choose SLE or USD.");
    const product={id:randomUUID(),title:text(x.title,"Product title",100),description:text(x.description,"Description",1500),category:text(x.category,"Category",60),price:Math.round(price*100)/100,stock,currency:x.currency,image:safeImage(x.image)};
    db.prepare("INSERT INTO products(id,vendor_id,title,description,category,price,currency,stock,image) VALUES(?,?,?,?,?,?,?,?,?)").run(product.id,user.id,product.title,product.description,product.category,product.price,product.currency,stock,product.image);
    return json(res,201,{product:productView(db.prepare("SELECT p.*,u.store_name FROM products p JOIN users u ON u.id=p.vendor_id WHERE p.id=?").get(product.id))});
  }
  const vendorOrder=path.match(/^\/api\/vendor\/orders\/([\w-]+)$/);
  if(req.method==="PATCH"&&vendorOrder) {
    role(user,"vendor"); const status=(await body(req)).status;
    if(!new Set(["processing","shipped","delivered"]).has(status)) fail(400,"Choose a valid fulfillment status.");
    const order=db.prepare("SELECT o.* FROM orders o JOIN order_items i ON i.order_id=o.id WHERE o.id=? AND i.vendor_id=?").get(vendorOrder[1],user.id);
    if(!order) fail(404,"Order not found.");
    db.prepare("UPDATE order_items SET fulfillment_status=? WHERE order_id=? AND vendor_id=?").run(status,order.id,user.id);
    const outstanding=db.prepare("SELECT COUNT(*) count FROM order_items WHERE order_id=? AND fulfillment_status!='delivered'").get(order.id).count;
    if(status==="delivered"&&order.payment_method==="cash_on_delivery"&&outstanding===0) db.prepare("UPDATE orders SET payment_status='paid',status='delivered' WHERE id=?").run(order.id);
    else db.prepare("UPDATE orders SET status=? WHERE id=?").run(outstanding===0?"delivered":"processing",order.id);
    return json(res,200,{order:orderView(db.prepare("SELECT * FROM orders WHERE id=?").get(order.id),user.id)});
  }
  if(req.method==="POST"&&path==="/api/vendor/payouts") {
    role(user,"vendor"); const x=await body(req),amount=Number(x.amount);
    if(!Number.isFinite(amount)||amount<=0||!new Set(["SLE","USD"]).has(x.currency)) fail(400,"Enter a valid amount and currency.");
    if(!new Set(["orange_money","afrimoney","bank_transfer"]).has(x.method)) fail(400,"Choose a payout method.");
    if(amount>balance(user.id,x.currency)) fail(409,"Payout exceeds the available balance.");
    const id=randomUUID(); db.prepare("INSERT INTO payouts(id,vendor_id,amount,currency,method,destination) VALUES(?,?,?,?,?,?)").run(id,user.id,Math.round(amount*100)/100,x.currency,x.method,text(x.destination,"Wallet or bank details",160));
    return json(res,201,{payout:db.prepare("SELECT id,amount,currency,method,destination,status,created_at AS createdAt FROM payouts WHERE id=?").get(id)});
  }
  if(req.method==="GET"&&path==="/api/admin/overview") {
    role(user,"admin"); const sales=db.prepare("SELECT currency,COALESCE(SUM(gross),0) gross,COALESCE(SUM(commission),0) commission,COUNT(*) orders FROM orders WHERE payment_status='paid' GROUP BY currency").all();
    return json(res,200,{stats:{sales,gross:sales.map(sale=>({currency:sale.currency,amount:sale.gross})),commission:sales.map(sale=>({currency:sale.currency,amount:sale.commission})),vendors:db.prepare("SELECT COUNT(*) count FROM users WHERE role='vendor' AND status='approved'").get().count,pendingVendors:db.prepare("SELECT COUNT(*) count FROM users WHERE role='vendor' AND status='pending'").get().count,pendingPayouts:db.prepare("SELECT COUNT(*) count FROM payouts WHERE status='pending'").get().count}});
  }
  if(req.method==="GET"&&path==="/api/admin/vendors") { role(user,"admin"); return json(res,200,{vendors:db.prepare("SELECT u.id,u.email,u.display_name AS displayName,u.store_name AS storeName,u.status,u.created_at AS createdAt,u.fee_percent AS feePercent,vp.slot AS promoSlot FROM users u LEFT JOIN vendor_promotions vp ON vp.user_id=u.id WHERE u.role='vendor' ORDER BY u.created_at DESC").all()}); }
  if(req.method==="GET"&&path==="/api/admin/messages") { role(user,"admin"); return json(res,200,{messages:db.prepare("SELECT id,name,email,topic,message,status,created_at AS createdAt FROM contact_messages ORDER BY CASE status WHEN 'new' THEN 0 ELSE 1 END,created_at DESC").all()}); }
  const adminMessage=path.match(/^\/api\/admin\/messages\/([\w-]+)$/);
  if(req.method==="PATCH"&&adminMessage) { role(user,"admin"); const status=(await body(req)).status; if(!new Set(["new","read"]).has(status)) fail(400,"Choose a valid message status."); if(!db.prepare("UPDATE contact_messages SET status=? WHERE id=?").run(status,adminMessage[1]).changes) fail(404,"Message not found."); return json(res,200,{ok:true}); }
  const adminVendor=path.match(/^\/api\/admin\/vendors\/([\w-]+)$/);
  if(req.method==="PATCH"&&adminVendor) {
    role(user,"admin"); const status=(await body(req)).status; if(!new Set(["approved","rejected"]).has(status)) fail(400,"Choose approve or reject.");
    const vendor=db.prepare("SELECT id,status,fee_percent FROM users WHERE id=? AND role='vendor'").get(adminVendor[1]);if(!vendor)fail(404,"Seller application not found.");
    db.exec("BEGIN IMMEDIATE");
    try{
      let vendorFee=vendor.fee_percent;
      if(status==="approved"&&vendor.status!=="approved"&&!db.prepare("SELECT 1 FROM vendor_promotions WHERE user_id=?").get(vendor.id)){
        const slot=db.prepare("SELECT COUNT(*) count FROM vendor_promotions").get().count+1;
        if(slot<=10){db.prepare("INSERT INTO vendor_promotions(user_id,slot) VALUES(?,?)").run(vendor.id,slot);vendorFee=5;}
      }
      db.prepare("UPDATE users SET status=?,fee_percent=? WHERE id=?").run(status,vendorFee,vendor.id);db.exec("COMMIT");
    }catch(error){db.exec("ROLLBACK");throw error;}
    return json(res,200,{ok:true,feePercent:status==="approved"?(vendorFee??fee()):null,promoRate:vendorFee===5});
  }
  if(req.method==="GET"&&path==="/api/admin/payouts") {
    role(user,"admin"); return json(res,200,{payouts:db.prepare("SELECT p.id,p.amount,p.currency,p.method,p.destination,p.status,p.created_at AS createdAt,u.store_name AS storeName,u.email FROM payouts p JOIN users u ON u.id=p.vendor_id ORDER BY p.created_at DESC").all()});
  }
  const adminPayout=path.match(/^\/api\/admin\/payouts\/([\w-]+)$/);
  if(req.method==="PATCH"&&adminPayout) {
    role(user,"admin"); const status=(await body(req)).status; if(!new Set(["approved","paid","rejected"]).has(status)) fail(400,"Choose a valid payout status.");
    if(!db.prepare("UPDATE payouts SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN('pending','approved')").run(status,adminPayout[1]).changes) fail(404,"Pending payout not found."); return json(res,200,{ok:true});
  }
  if(req.method==="GET"&&path==="/api/admin/settings") { role(user,"admin"); return json(res,200,{commissionPercent:fee()}); }
  if(req.method==="PATCH"&&path==="/api/admin/settings/commission") {
    role(user,"admin"); const percentage=Number((await body(req)).percentage); if(!Number.isFinite(percentage)||percentage<5||percentage>10) fail(400,"Commission must be between 5% and 10%.");
    db.prepare("UPDATE settings SET value=? WHERE key='commission_percent'").run(String(percentage)); return json(res,200,{commissionPercent:percentage});
  }
  return json(res,404,{error:"Not found."});
}
async function serveStatic(path,res) {
  if(!["/","/index.html","/fashion.html","/electronics.html","/beauty.html","/vendor.html","/cart.html","/checkout.html","/signup.html","/about.html","/contact.html","/site.css","/css/styles.css","/js/main.js","/logo.svg"].includes(path)) return json(res,404,{error:"Not found."});
  const target=resolve(root,`.${path==="/"?"/index.html":path}`);
  if(target!==root&&!target.startsWith(`${root}${sep}`)) return json(res,404,{error:"Not found."});
  try { if(!(await stat(target)).isFile()) return json(res,404,{error:"Not found."}); res.writeHead(200,{"Content-Type":mime[extname(target)]||"application/octet-stream","X-Content-Type-Options":"nosniff","Referrer-Policy":"strict-origin-when-cross-origin"}); res.end(await readFile(target)); }
  catch { json(res,404,{error:"Not found."}); }
}
const server=createServer((req,res)=>route(req,res).catch(error=>{const status=error instanceof HttpError?error.status:500;if(status===500)console.error(error);if(!res.headersSent)json(res,status,{error:status===500?"Something went wrong. Please try again.":error.message});else res.destroy();}));
const host=process.env.HOST||"127.0.0.1",port=Number(process.env.PORT||4175);
server.listen(port,host,()=>console.log(`XD-MARKET listening at http://${host}:${port}`));
for(const signal of ["SIGINT","SIGTERM"])process.on(signal,()=>server.close(()=>{db.close();process.exit(0);}));
