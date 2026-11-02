import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { calculateCommission } from "./lib/marketplace.mjs";
import { openDatabase } from "./lib/database.mjs";
import { runMigrations } from "./lib/migrations.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const db = await openDatabase();
await runMigrations(db);
const cookieName = "salonemarket_session";
const loginAttempts = new Map();
const frontendOrigin = process.env.FRONTEND_ORIGIN ? new URL(process.env.FRONTEND_ORIGIN).origin : "";
const mime = { ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

function hashPassword(password, salt = randomBytes(16).toString("hex")) { return { salt, hash: scryptSync(password, salt, 64).toString("hex") }; }
if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  await db.transaction(async tx => {
    if (db.dialect === "postgres") await tx.exec("SELECT pg_advisory_xact_lock(hashtext('e-market-admin-bootstrap'))");
    if (await tx.prepare("SELECT 1 FROM users WHERE role='admin'").get()) return;
    const email = process.env.ADMIN_EMAIL.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || process.env.ADMIN_PASSWORD.length < 12) throw new Error("Set a valid ADMIN_EMAIL and an ADMIN_PASSWORD of at least 12 characters.");
    const { salt, hash } = hashPassword(process.env.ADMIN_PASSWORD);
    await tx.prepare("INSERT INTO users(id,email,display_name,role,status,salt,password_hash) VALUES(?,?,?,'admin','approved',?,?)").run(randomUUID(), email, "XD-MARKET Admin", salt, hash);
  });
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
async function userFor(req, res, required = true) {
  const token = (req.headers.cookie || "").split(";").map(item => item.trim()).find(item => item.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  if (!token) { if (required) fail(401, "Sign in to continue."); return null; }
  const key = createHash("sha256").update(token).digest("hex"), session = await db.prepare("SELECT user_id,last_activity FROM sessions WHERE token_hash=?").get(key);
  if (!session || Date.now() - session.last_activity >= 1_800_000) { await db.prepare("DELETE FROM sessions WHERE token_hash=?").run(key); res.setHeader("Set-Cookie", cookie("", 0)); if (required) fail(401, "Your session expired. Sign in again."); return null; }
  await db.prepare("UPDATE sessions SET last_activity=? WHERE token_hash=?").run(Date.now(), key); res.setHeader("Set-Cookie", cookie(token));
  return db.prepare("SELECT id,email,display_name AS displayName,store_name AS storeName,phone,role,status FROM users WHERE id=?").get(session.user_id);
}
async function issueSession(res, id) { const token = randomBytes(32).toString("base64url"); await db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(createHash("sha256").update(token).digest("hex"), id, Date.now()); res.setHeader("Set-Cookie", cookie(token)); }
function role(user, expected) { if (user.role !== expected) fail(403, "You do not have access to this page."); if (expected === "vendor" && user.status !== "approved") fail(403, "Your seller application is awaiting approval."); }
async function fee() { return Number((await db.prepare("SELECT value FROM settings WHERE key='commission_percent'").get()).value); }
function safeImage(value) { if (!value) return ""; if (typeof value !== "string" || value.length > 2_700_000 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) fail(400, "Use a PNG, JPEG, or WebP photo smaller than 2 MB."); return value; }
function productView(row) { return { id: row.id, vendorId: row.vendor_id, vendor: row.store_name, title: row.title, description: row.description, category: row.category, price: row.price, currency: row.currency, stock: row.stock, image: row.image }; }
async function orderView(row, vendorId = null) {
  const items = await db.prepare(`SELECT id,product_id AS productId,vendor_id AS vendorId,title,quantity,unit_price AS unitPrice,currency,commission,vendor_net AS vendorNet,fulfillment_status AS status FROM order_items WHERE order_id=?${vendorId ? " AND vendor_id=?" : ""}`).all(...(vendorId ? [row.id, vendorId] : [row.id]));
  const gross = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  const commission = items.reduce((sum, item) => sum + item.commission, 0);
  const vendorNet = items.reduce((sum, item) => sum + item.vendorNet, 0);
  const statuses = [...new Set(items.map(item => item.status))];
  return { id: row.id, customerName: row.customer_name, email: row.email, phone: row.phone, address: row.address, city: row.city, currency: row.currency, gross: vendorId ? gross : row.gross, commission: vendorId ? commission : row.commission, vendorNet: vendorId ? vendorNet : row.vendor_net, freeDelivery: Boolean(row.free_delivery), paymentMethod: row.payment_method, paymentStatus: row.payment_status, status: vendorId ? statuses.length === 1 ? statuses[0] : "in progress" : row.status, createdAt: row.created_at, items };
}
async function balance(vendorId, currency, database = db) {
  const earned = (await database.prepare("SELECT COALESCE(SUM(i.vendor_net),0) amount FROM order_items i JOIN orders o ON o.id=i.order_id WHERE i.vendor_id=? AND i.currency=? AND o.payment_status='paid'").get(vendorId, currency)).amount;
  const held = (await database.prepare("SELECT COALESCE(SUM(amount),0) amount FROM payouts WHERE vendor_id=? AND currency=? AND status IN('pending','approved','paid')").get(vendorId, currency)).amount;
  return Math.round((earned - held) * 100) / 100;
}
async function createOrder(user, input) {
  const name = text(input.name, "Full name", 100), email = text(input.email, "Email", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, "Enter a valid email address.");
  const phone = text(input.phone, "Phone number", 40), address = text(input.address, "Shipping address", 200), city = text(input.city, "City or district", 80), method = text(input.paymentMethod, "Payment method", 40);
  if (!["orange_money", "afrimoney", "card", "bank_transfer", "cash_on_delivery"].includes(method)) fail(400, "Choose a supported payment method.");
  if (method === "cash_on_delivery" && process.env.NODE_ENV === "production") fail(400, "Cash on delivery is not enabled for this store.");
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 40) fail(400, "Your cart is empty or too large.");
  const quantities = new Map();
  for (const item of input.items) { if (!item || typeof item.productId !== "string" || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) fail(400, "Invalid cart item."); quantities.set(item.productId, (quantities.get(item.productId) || 0) + item.quantity); }
  const items = [];
  for (const [id, quantity] of quantities) {
    const product = await db.prepare("SELECT p.*,u.store_name,u.fee_percent FROM products p JOIN users u ON u.id=p.vendor_id WHERE p.id=? AND p.active=1 AND u.status='approved'").get(id);
    if (!product || product.stock < quantity) fail(409, "A product is unavailable or has insufficient stock.");
    items.push({ product, quantity, ...calculateCommission(product.price * quantity, product.fee_percent ?? await fee()) });
  }
  if (new Set(items.map(item => item.product.currency)).size !== 1) fail(400, "Checkout items must use the same currency.");
  const currency = items[0].product.currency, gross = items.reduce((sum, item) => sum + item.gross, 0), commission = items.reduce((sum, item) => sum + item.commission, 0), net = items.reduce((sum, item) => sum + item.vendorNet, 0);
  const id = randomUUID(), txRef = method === "cash_on_delivery" ? null : `SM-${id}`;
  await db.transaction(async tx => {
    if (db.dialect === "postgres") await tx.exec("SELECT pg_advisory_xact_lock(hashtext('e-market-order-reservations'))");
    const expiry=Date.now()-30*60*1000;
    await tx.prepare("UPDATE orders SET free_delivery=0 WHERE id IN(SELECT order_id FROM delivery_promotions WHERE status='reserved' AND claimed_at<?)").run(expiry);
    await tx.prepare("DELETE FROM delivery_promotions WHERE status='reserved' AND claimed_at<?").run(expiry);
    const hasDeliveryAward=await tx.prepare("SELECT 1 FROM delivery_promotions WHERE user_id=?").get(user.id);
    const awardCount=(await tx.prepare("SELECT COUNT(*) count FROM delivery_promotions").get()).count;
    const freeDelivery=!hasDeliveryAward&&awardCount<5;
    for (const item of items) if ((await tx.prepare("UPDATE products SET stock=stock-? WHERE id=? AND stock>=?").run(item.quantity, item.product.id, item.quantity)).changes !== 1) fail(409, "A product just sold out. Refresh and try again.");
    await tx.prepare("INSERT INTO orders(id,customer_id,customer_name,email,phone,address,city,currency,gross,commission,vendor_net,payment_method,payment_status,status,tx_ref,free_delivery) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, user.id, name, email, phone, address, city, currency, gross, commission, net, method, method === "cash_on_delivery" ? "pending" : "awaiting_payment", "placed", txRef, Number(freeDelivery));
    if(freeDelivery) await tx.prepare("INSERT INTO delivery_promotions(user_id,order_id,status,claimed_at) VALUES(?,?,?,?)").run(user.id,id,method==="cash_on_delivery"?"redeemed":"reserved",Date.now());
    for (const item of items) await tx.prepare("INSERT INTO order_items(id,order_id,product_id,vendor_id,title,quantity,unit_price,currency,commission,vendor_net) VALUES(?,?,?,?,?,?,?,?,?,?)").run(randomUUID(), id, item.product.id, item.product.vendor_id, item.product.title, item.quantity, item.product.price, currency, item.commission, item.vendorNet);
  });
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
  const result = await response.json().catch(() => ({})), order = await db.prepare("SELECT * FROM orders WHERE tx_ref=?").get(txRef);
  if (!response.ok || result.status !== "success" || !order) return false;
  const data = result.data;
  if (data.status !== "successful" || data.tx_ref !== txRef || data.currency !== order.currency || Number(data.amount) < order.gross) return false;
  await db.prepare("UPDATE orders SET payment_status='paid',status=CASE WHEN status='placed' THEN 'processing' ELSE status END WHERE id=? AND payment_status!='paid'").run(order.id);
  await db.prepare("UPDATE delivery_promotions SET status='redeemed' WHERE order_id=? AND status='reserved'").run(order.id);
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
    const [products, vendors, delivery, vendorCount, commissionPercent] = await Promise.all([
      db.prepare("SELECT p.*,u.store_name FROM products p JOIN users u ON u.id=p.vendor_id WHERE p.active=1 AND p.stock>0 AND u.status='approved' ORDER BY p.created_at DESC").all(),
      db.prepare("SELECT u.id,u.store_name AS name,u.display_name AS displayName,COUNT(p.id) products FROM users u JOIN products p ON p.vendor_id=u.id AND p.active=1 WHERE u.role='vendor' AND u.status='approved' GROUP BY u.id ORDER BY products DESC LIMIT 6").all(),
      db.prepare("SELECT COUNT(*) count FROM delivery_promotions WHERE status='redeemed' OR claimed_at>?").get(Date.now()-30*60*1000),
      db.prepare("SELECT COUNT(*) count FROM vendor_promotions").get(),
      fee(),
    ]);
    return json(res, 200, { products: products.map(productView), vendors, commissionPercent, promotions:{freeDeliveryRemaining:Math.max(0,5-delivery.count),vendorCommissionRemaining:Math.max(0,10-vendorCount.count)} });
  }
  if (path.startsWith("/api/") && req.method !== "GET" && path !== "/api/flutterwave/webhook") sameOrigin(req);
  if (req.method === "POST" && path === "/api/contact") {
    const input=await body(req),name=text(input.name,"Name",100),email=text(input.email,"Email",254).toLowerCase(),topic=text(input.topic,"Subject",120),message=text(input.message,"Message",3000);
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400,"Enter a valid email address.");
    await db.prepare("INSERT INTO contact_messages(id,name,email,topic,message) VALUES(?,?,?,?,?)").run(randomUUID(),name,email,topic,message);
    return json(res,201,{received:true});
  }
  if (req.method === "GET" && path === "/api/auth/me") return json(res, 200, { user: await userFor(req, res, false) });
  if (req.method === "POST" && path === "/api/auth/register") {
    const input = await body(req), roleName = input.role === "buyer" ? "customer" : input.role;
    if (!new Set(["customer", "vendor"]).has(roleName)) fail(400, "Choose buyer or seller registration.");
    const email = text(input.email, "Email", 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, "Enter a valid email address.");
    const phone=text(input.phone,"Phone number",30),phoneDigits=phone.replace(/\D/g,"");
    if(phoneDigits.length<7||phoneDigits.length>15||!/^[+0-9().\s-]+$/.test(phone)) fail(400,"Enter a valid international phone number.");
    if (typeof input.password !== "string" || input.password.length < 12 || input.password.length > 128) fail(400, "Password must be 12–128 characters.");
    const name = text(input.displayName, "Your name", 100), store = roleName === "vendor" ? text(input.storeName, "Store name", 100) : "", id = randomUUID(), { salt, hash } = hashPassword(input.password);
    try { await db.prepare("INSERT INTO users(id,email,display_name,store_name,phone,role,status,salt,password_hash) VALUES(?,?,?,?,?,?,?,?,?)").run(id,email,name,store,phone,roleName,roleName === "vendor" ? "pending" : "approved",salt,hash); }
    catch (error) { if (error.code === "23505" || error.code === "SQLITE_CONSTRAINT_UNIQUE" || error.code === "ERR_SQLITE_CONSTRAINT_UNIQUE") fail(409, "An account with this email already exists."); throw error; }
    await issueSession(res,id);
    return json(res,201,{ user: await db.prepare("SELECT id,email,display_name AS displayName,store_name AS storeName,phone,role,status FROM users WHERE id=?").get(id) });
  }
  if (req.method === "POST" && path === "/api/auth/login") {
    const input = await body(req), email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "", account = await db.prepare("SELECT * FROM users WHERE email=?").get(email);
    const key=`${req.socket.remoteAddress}:${email}`,now=Date.now(),previous=loginAttempts.get(key);
    if(previous?.until>now) fail(429,"Too many attempts. Try again in 15 minutes.");
    const valid = typeof input.password === "string" && input.password.length <= 128 && account && timingSafeEqual(Buffer.from(hashPassword(input.password,account.salt).hash,"hex"),Buffer.from(account.password_hash,"hex"));
    if (!valid) {
      const attempt=previous&&now-previous.started<900_000?previous:{count:0,started:now};
      attempt.count++;if(attempt.count>=5)attempt.until=now+900_000;loginAttempts.set(key,attempt);
      fail(401,"Email or password is incorrect.");
    }
    loginAttempts.delete(key);
    await issueSession(res,account.id);
    return json(res,200,{ user:{id:account.id,email:account.email,displayName:account.display_name,storeName:account.store_name,phone:account.phone,role:account.role,status:account.status} });
  }
  if (req.method === "POST" && path === "/api/auth/logout") {
    const token=(req.headers.cookie||"").split(";").map(x=>x.trim()).find(x=>x.startsWith(`${cookieName}=`))?.slice(cookieName.length+1);
    if(token) await db.prepare("DELETE FROM sessions WHERE token_hash=?").run(createHash("sha256").update(token).digest("hex"));
    return json(res,200,{ok:true},{"Set-Cookie":cookie("",0)});
  }
  if (req.method === "POST" && path === "/api/orders") {
    const user=await userFor(req,res); if(user.role!=="customer") fail(403,"Sign in with a buyer account to place an order.");
    const order=await createOrder(user,await body(req));
    if(order.payment_method==="cash_on_delivery") return json(res,201,{order:await orderView(order)});
    try { return json(res,201,{order:await orderView(order),checkoutUrl:await startFlutterwave(order,req)}); }
    catch(error) {
      await db.transaction(async tx => {
        for (const item of await tx.prepare("SELECT product_id,quantity FROM order_items WHERE order_id=?").all(order.id)) await tx.prepare("UPDATE products SET stock=stock+? WHERE id=?").run(item.quantity,item.product_id);
        await tx.prepare("DELETE FROM delivery_promotions WHERE order_id=? AND status='reserved'").run(order.id);
        await tx.prepare("UPDATE orders SET payment_status='payment_setup_failed',free_delivery=0 WHERE id=?").run(order.id);
      });
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
  const user=await userFor(req,res);
  if(req.method==="GET"&&path==="/api/vendor/summary") {
    role(user,"vendor");
    const [products, orderRows, payouts, vendorDetails] = await Promise.all([
      db.prepare("SELECT * FROM products WHERE vendor_id=? AND active=1 ORDER BY created_at DESC").all(user.id),
      db.prepare("SELECT DISTINCT o.* FROM orders o JOIN order_items i ON i.order_id=o.id WHERE i.vendor_id=? ORDER BY o.created_at DESC").all(user.id),
      db.prepare("SELECT id,amount,currency,method,destination,status,created_at AS createdAt FROM payouts WHERE vendor_id=? ORDER BY created_at DESC").all(user.id),
      db.prepare("SELECT fee_percent FROM users WHERE id=?").get(user.id),
    ]);
    const orders=await Promise.all(orderRows.map(order=>orderView(order,user.id)));
    const currencies=[...new Set([...products.map(x=>x.currency),...orders.map(x=>x.currency),...payouts.map(x=>x.currency)])];
    const vendorFee=vendorDetails.fee_percent;
    const balances=await Promise.all(currencies.map(async currency=>[currency,await balance(user.id,currency)]));
    return json(res,200,{products:products.map(productView),orders,payouts,balances:Object.fromEntries(balances),commissionPercent:vendorFee??await fee(),promoRate:vendorFee===5});
  }
  if(req.method==="POST"&&path==="/api/vendor/products") {
    role(user,"vendor"); const x=await body(req),price=Number(x.price),stock=Number(x.stock);
    if(!Number.isFinite(price)||price<=0||price>1e9) fail(400,"Enter a valid price.");
    if(!Number.isInteger(stock)||stock<0||stock>1e6) fail(400,"Enter a valid stock quantity.");
    if(!new Set(["SLE","USD"]).has(x.currency)) fail(400,"Choose SLE or USD.");
    const product={id:randomUUID(),title:text(x.title,"Product title",100),description:text(x.description,"Description",1500),category:text(x.category,"Category",60),price:Math.round(price*100)/100,stock,currency:x.currency,image:safeImage(x.image)};
    await db.prepare("INSERT INTO products(id,vendor_id,title,description,category,price,currency,stock,image) VALUES(?,?,?,?,?,?,?,?,?)").run(product.id,user.id,product.title,product.description,product.category,product.price,product.currency,stock,product.image);
    return json(res,201,{product:productView(await db.prepare("SELECT p.*,u.store_name FROM products p JOIN users u ON u.id=p.vendor_id WHERE p.id=?").get(product.id))});
  }
  const vendorOrder=path.match(/^\/api\/vendor\/orders\/([\w-]+)$/);
  if(req.method==="PATCH"&&vendorOrder) {
    role(user,"vendor"); const status=(await body(req)).status;
    if(!new Set(["processing","shipped","delivered"]).has(status)) fail(400,"Choose a valid fulfillment status.");
    const order=await db.prepare("SELECT o.* FROM orders o JOIN order_items i ON i.order_id=o.id WHERE o.id=? AND i.vendor_id=?").get(vendorOrder[1],user.id);
    if(!order) fail(404,"Order not found.");
    await db.prepare("UPDATE order_items SET fulfillment_status=? WHERE order_id=? AND vendor_id=?").run(status,order.id,user.id);
    const outstanding=(await db.prepare("SELECT COUNT(*) count FROM order_items WHERE order_id=? AND fulfillment_status!='delivered'").get(order.id)).count;
    if(status==="delivered"&&order.payment_method==="cash_on_delivery"&&outstanding===0) await db.prepare("UPDATE orders SET payment_status='paid',status='delivered' WHERE id=?").run(order.id);
    else await db.prepare("UPDATE orders SET status=? WHERE id=?").run(outstanding===0?"delivered":"processing",order.id);
    return json(res,200,{order:await orderView(await db.prepare("SELECT * FROM orders WHERE id=?").get(order.id),user.id)});
  }
  if(req.method==="POST"&&path==="/api/vendor/payouts") {
    role(user,"vendor"); const x=await body(req),amount=Number(x.amount);
    if(!Number.isFinite(amount)||amount<=0||!new Set(["SLE","USD"]).has(x.currency)) fail(400,"Enter a valid amount and currency.");
    if(!new Set(["orange_money","afrimoney","bank_transfer"]).has(x.method)) fail(400,"Choose a payout method.");
    const id=randomUUID(), destination=text(x.destination,"Wallet or bank details",160);
    await db.transaction(async tx => {
      if (db.dialect === "postgres") await tx.prepare("SELECT id FROM users WHERE id=? FOR UPDATE").get(user.id);
      if(amount>await balance(user.id,x.currency,tx)) fail(409,"Payout exceeds the available balance.");
      await tx.prepare("INSERT INTO payouts(id,vendor_id,amount,currency,method,destination) VALUES(?,?,?,?,?,?)").run(id,user.id,Math.round(amount*100)/100,x.currency,x.method,destination);
    });
    return json(res,201,{payout:await db.prepare("SELECT id,amount,currency,method,destination,status,created_at AS createdAt FROM payouts WHERE id=?").get(id)});
  }
  if(req.method==="GET"&&path==="/api/admin/overview") {
    role(user,"admin");
    const [sales, vendors, pendingVendors, pendingPayouts] = await Promise.all([
      db.prepare("SELECT currency,COALESCE(SUM(gross),0) gross,COALESCE(SUM(commission),0) commission,COUNT(*) orders FROM orders WHERE payment_status='paid' GROUP BY currency").all(),
      db.prepare("SELECT COUNT(*) count FROM users WHERE role='vendor' AND status='approved'").get(),
      db.prepare("SELECT COUNT(*) count FROM users WHERE role='vendor' AND status='pending'").get(),
      db.prepare("SELECT COUNT(*) count FROM payouts WHERE status='pending'").get(),
    ]);
    return json(res,200,{stats:{sales,gross:sales.map(sale=>({currency:sale.currency,amount:sale.gross})),commission:sales.map(sale=>({currency:sale.currency,amount:sale.commission})),vendors:vendors.count,pendingVendors:pendingVendors.count,pendingPayouts:pendingPayouts.count}});
  }
  if(req.method==="GET"&&path==="/api/admin/vendors") { role(user,"admin"); return json(res,200,{vendors:await db.prepare("SELECT u.id,u.email,u.display_name AS displayName,u.store_name AS storeName,u.status,u.created_at AS createdAt,u.fee_percent AS feePercent,vp.slot AS promoSlot FROM users u LEFT JOIN vendor_promotions vp ON vp.user_id=u.id WHERE u.role='vendor' ORDER BY u.created_at DESC").all()}); }
  if(req.method==="GET"&&path==="/api/admin/messages") { role(user,"admin"); return json(res,200,{messages:await db.prepare("SELECT id,name,email,topic,message,status,created_at AS createdAt FROM contact_messages ORDER BY CASE status WHEN 'new' THEN 0 ELSE 1 END,created_at DESC").all()}); }
  const adminMessage=path.match(/^\/api\/admin\/messages\/([\w-]+)$/);
  if(req.method==="PATCH"&&adminMessage) { role(user,"admin"); const status=(await body(req)).status; if(!new Set(["new","read"]).has(status)) fail(400,"Choose a valid message status."); if(!(await db.prepare("UPDATE contact_messages SET status=? WHERE id=?").run(status,adminMessage[1])).changes) fail(404,"Message not found."); return json(res,200,{ok:true}); }
  const adminVendor=path.match(/^\/api\/admin\/vendors\/([\w-]+)$/);
  if(req.method==="PATCH"&&adminVendor) {
    role(user,"admin"); const status=(await body(req)).status; if(!new Set(["approved","rejected"]).has(status)) fail(400,"Choose approve or reject.");
    const vendor=await db.prepare("SELECT id,status,fee_percent FROM users WHERE id=? AND role='vendor'").get(adminVendor[1]);if(!vendor)fail(404,"Seller application not found.");
    let vendorFee=vendor.fee_percent;
    await db.transaction(async tx => {
      if (db.dialect === "postgres") await tx.exec("SELECT pg_advisory_xact_lock(hashtext('e-market-order-reservations'))");
      const current=await tx.prepare("SELECT id,status,fee_percent FROM users WHERE id=? AND role='vendor'").get(vendor.id);
      if(!current)fail(404,"Seller application not found.");
      vendorFee=current.fee_percent;
      if(status==="approved"&&current.status!=="approved"&&!await tx.prepare("SELECT 1 FROM vendor_promotions WHERE user_id=?").get(vendor.id)){
        const slot=(await tx.prepare("SELECT COUNT(*) count FROM vendor_promotions").get()).count+1;
        if(slot<=10){await tx.prepare("INSERT INTO vendor_promotions(user_id,slot) VALUES(?,?)").run(vendor.id,slot);vendorFee=5;}
      }
      await tx.prepare("UPDATE users SET status=?,fee_percent=? WHERE id=?").run(status,vendorFee,vendor.id);
    });
    return json(res,200,{ok:true,feePercent:status==="approved"?(vendorFee??await fee()):null,promoRate:vendorFee===5});
  }
  if(req.method==="GET"&&path==="/api/admin/payouts") {
    role(user,"admin"); return json(res,200,{payouts:await db.prepare("SELECT p.id,p.amount,p.currency,p.method,p.destination,p.status,p.created_at AS createdAt,u.store_name AS storeName,u.email FROM payouts p JOIN users u ON u.id=p.vendor_id ORDER BY p.created_at DESC").all()});
  }
  const adminPayout=path.match(/^\/api\/admin\/payouts\/([\w-]+)$/);
  if(req.method==="PATCH"&&adminPayout) {
    role(user,"admin"); const status=(await body(req)).status; if(!new Set(["approved","paid","rejected"]).has(status)) fail(400,"Choose a valid payout status.");
    if(!(await db.prepare("UPDATE payouts SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN('pending','approved')").run(status,adminPayout[1])).changes) fail(404,"Pending payout not found."); return json(res,200,{ok:true});
  }
  if(req.method==="GET"&&path==="/api/admin/settings") { role(user,"admin"); return json(res,200,{commissionPercent:await fee()}); }
  if(req.method==="PATCH"&&path==="/api/admin/settings/commission") {
    role(user,"admin"); const percentage=Number((await body(req)).percentage); if(!Number.isFinite(percentage)||percentage<5||percentage>10) fail(400,"Commission must be between 5% and 10%.");
    await db.prepare("UPDATE settings SET value=? WHERE key='commission_percent'").run(String(percentage)); return json(res,200,{commissionPercent:percentage});
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
for(const signal of ["SIGINT","SIGTERM"])process.on(signal,()=>server.close(async()=>{await db.close();process.exit(0);}));
