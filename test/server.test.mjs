import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { calculateCommission } from "../lib/marketplace.mjs";

async function availablePort() {
  const server=createServer(); server.listen(0,"127.0.0.1"); await once(server,"listening"); const port=server.address().port;
  await new Promise((resolveClose,rejectClose)=>server.close(error=>error?rejectClose(error):resolveClose())); return port;
}

test("commission uses rounded minor currency units and enforces configured range",()=>{
  assert.deepEqual(calculateCommission(500,10),{gross:500,commission:50,vendorNet:450});
  assert.deepEqual(calculateCommission(100,5),{gross:100,commission:5,vendorNet:95});
  assert.deepEqual(calculateCommission(19.99,10),{gross:19.99,commission:2,vendorNet:17.99});
  assert.throws(()=>calculateCommission(100,11),RangeError);
});

test("seller approval, order split, balance, payout, and admin settings",{timeout:25000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),"salonemarket-test-")),databasePath=join(directory,"test.sqlite"),port=await availablePort(),origin=`http://127.0.0.1:${port}`,adminPassword="OnlyForAutomatedTests2026!";
  const child=spawn(process.execPath,[resolve("server.mjs")],{cwd:process.cwd(),env:{...process.env,HOST:"127.0.0.1",PORT:String(port),APP_ORIGIN:origin,FRONTEND_ORIGIN:"https://xdmarket.example",NODE_ENV:"test",MARKET_DB_PATH:databasePath,ADMIN_EMAIL:"admin@example.org",ADMIN_PASSWORD:adminPassword,FLW_SECRET_KEY:"",FLW_WEBHOOK_SECRET:""},stdio:["ignore","ignore","pipe"]});
  let errors="";child.stderr.setEncoding("utf8").on("data",chunk=>errors+=chunk);
  t.after(async()=>{child.kill("SIGTERM");if(child.exitCode===null)await once(child,"exit");await rm(directory,{recursive:true,force:true});});
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(`${origin}/api/store`)).ok){ready=true;break;}}catch{}await new Promise(resolveWait=>setTimeout(resolveWait,50));}
  assert.equal(ready,true,`server did not start: ${errors}`);
  async function api(path,{method="GET",body,cookie,requestOrigin=origin}={}){const headers={};if(method!=="GET")headers.Origin=requestOrigin;if(body!==undefined)headers["Content-Type"]="application/json";if(cookie)headers.Cookie=cookie;const response=await fetch(`${origin}${path}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});const setCookie=response.headers.get("set-cookie")||"";return{status:response.status,data:await response.json(),cookie:setCookie.split(";")[0],setCookie};}
  const preflight=await fetch(`${origin}/api/auth/register`,{method:"OPTIONS",headers:{Origin:"https://xdmarket.example","Access-Control-Request-Method":"POST","Access-Control-Request-Headers":"content-type"}});assert.equal(preflight.status,204);assert.equal(preflight.headers.get("access-control-allow-origin"),"https://xdmarket.example");assert.equal(preflight.headers.get("access-control-allow-credentials"),"true");
  assert.equal((await fetch(`${origin}/api/auth/register`,{method:"OPTIONS",headers:{Origin:"https://untrusted.example","Access-Control-Request-Method":"POST"}})).status,403);
  for(const path of ["/","/index.html","/fashion.html","/electronics.html","/beauty.html","/about.html","/contact.html","/vendor.html","/signup.html","/cart.html","/checkout.html","/site.css","/css/styles.css","/js/main.js","/logo.svg"]){const response=await fetch(`${origin}${path}`);assert.equal(response.status,200,`${path} should be served`);}
  assert.equal((await api("/api/admin/messages")).status,401);
  const message=await api("/api/contact",{method:"POST",body:{name:"Test visitor",email:"visitor@example.org",topic:"Seller question",message:"How can I open a shop?"}});assert.equal(message.status,201);
  assert.equal((await api("/api/contact",{method:"POST",body:{name:"Bad email",email:"not-an-email",topic:"Question",message:"Hello"}})).status,400);
  const vendor=await api("/api/auth/register",{method:"POST",body:{role:"vendor",displayName:"Mariama",storeName:"Freetown Finds",email:"vendor@example.org",phone:"+232 76 123 456",password:"VendorPassword2026!"}});
  assert.equal(vendor.status,201);assert.equal(vendor.data.user.status,"pending");
  const admin=await api("/api/auth/login",{method:"POST",body:{email:"admin@example.org",password:adminPassword}});assert.equal(admin.status,200);
  const inbox=await api("/api/admin/messages",{cookie:admin.cookie});assert.equal(inbox.data.messages.length,1);assert.equal(inbox.data.messages[0].topic,"Seller question");
  assert.equal((await api(`/api/admin/messages/${inbox.data.messages[0].id}`,{method:"PATCH",cookie:admin.cookie,body:{status:"read"}})).status,200);
  const blocked=await api("/api/vendor/products",{method:"POST",cookie:vendor.cookie,body:{title:"Basket",description:"Woven by hand",category:"Crafts",price:500,currency:"SLE",stock:3}});assert.equal(blocked.status,403);
  const list=await api("/api/admin/vendors",{cookie:admin.cookie}),vendorId=list.data.vendors[0].id;
  await api(`/api/admin/vendors/${vendorId}`,{method:"PATCH",cookie:admin.cookie,body:{status:"approved"}});
  const product=await api("/api/vendor/products",{method:"POST",cookie:vendor.cookie,body:{title:"Handwoven basket",description:"Woven in Sierra Leone",category:"Crafts",price:500,currency:"SLE",stock:3}});assert.equal(product.status,201);
  assert.equal((await api("/api/auth/register",{method:"POST",body:{role:"buyer",displayName:"Bad phone",email:"badphone@example.org",phone:"abc",password:"ValidPassword2026!"}})).status,400);
  const vendor2=await api("/api/auth/register",{method:"POST",requestOrigin:"https://xdmarket.example",body:{role:"vendor",displayName:"Abu",storeName:"Bo Harvest",email:"vendor2@example.org",phone:"+232 77 123 456",password:"SecondVendorPassword2026!"}});
  assert.match(vendor2.setCookie,/SameSite=None/);assert.match(vendor2.setCookie,/Secure/);
  const vendorId2=(await api("/api/admin/vendors",{cookie:admin.cookie})).data.vendors.find(item=>item.email==="vendor2@example.org").id;
  await api(`/api/admin/vendors/${vendorId2}`,{method:"PATCH",cookie:admin.cookie,body:{status:"approved"}});
  const initialVendorPromos=(await api("/api/admin/vendors",{cookie:admin.cookie})).data.vendors.filter(item=>item.promoSlot);assert.equal(initialVendorPromos.length,2);assert.deepEqual(initialVendorPromos.map(item=>item.promoSlot).sort(),[1,2]);
  let eleventhVendor;
  for(let index=3;index<=11;index++){
    const signup=await api("/api/auth/register",{method:"POST",body:{role:"vendor",displayName:`Seller ${index}`,storeName:`Shop ${index}`,email:`seller${index}@example.org`,phone:`+232 77 200 ${String(index).padStart(3,"0")}`,password:"AdditionalVendorPassword2026!"}});
    const id=signup.data.user.id;await api(`/api/admin/vendors/${id}`,{method:"PATCH",cookie:admin.cookie,body:{status:"approved"}});if(index===11)eleventhVendor=signup;
  }
  const allVendors=(await api("/api/admin/vendors",{cookie:admin.cookie})).data.vendors;assert.equal(allVendors.filter(item=>item.promoSlot).length,10);assert.equal(allVendors.find(item=>item.email==="seller11@example.org").feePercent,null);
  const product2=await api("/api/vendor/products",{method:"POST",cookie:vendor2.cookie,body:{title:"Local cacao",description:"Small batch",category:"Food",price:100,currency:"SLE",stock:5}});assert.equal(product2.status,201);
  const usdProduct=await api("/api/vendor/products",{method:"POST",cookie:vendor2.cookie,body:{title:"Cacao gift set",description:"A gift from Salone",category:"Food",price:20,currency:"USD",stock:8}});assert.equal(usdProduct.status,201);
  const buyer=await api("/api/auth/register",{method:"POST",body:{role:"customer",displayName:"Test Buyer",email:"buyer@example.org",phone:"+232 78 123 456",password:"BuyerPassword2026!"}});
  const order=await api("/api/orders",{method:"POST",cookie:buyer.cookie,body:{name:"Test Buyer",email:"buyer@example.org",phone:"+232 76 000 000",address:"12 Wilkinson Road",city:"Freetown",paymentMethod:"cash_on_delivery",items:[{productId:product.data.product.id,quantity:1},{productId:product2.data.product.id,quantity:1}]}});
  assert.equal(order.status,201);assert.equal(order.data.order.gross,600);assert.equal(order.data.order.commission,30);assert.equal(order.data.order.vendorNet,570);assert.equal(order.data.order.freeDelivery,true);
  for(let index=2;index<=5;index++){
    const extraBuyer=await api("/api/auth/register",{method:"POST",body:{role:"buyer",displayName:`Buyer ${index}`,email:`buyer${index}@example.org`,phone:`+232 78 300 ${String(index).padStart(3,"0")}`,password:"ExtraBuyerPassword2026!"}});
    const extraOrder=await api("/api/orders",{method:"POST",cookie:extraBuyer.cookie,body:{name:`Buyer ${index}`,email:`buyer${index}@example.org`,phone:`+232 78 300 ${String(index).padStart(3,"0")}`,address:"Market Street",city:"Bo",paymentMethod:"cash_on_delivery",items:[{productId:usdProduct.data.product.id,quantity:1}]}});assert.equal(extraOrder.data.order.freeDelivery,true);
  }
  const sixthBuyer=await api("/api/auth/register",{method:"POST",body:{role:"buyer",displayName:"Buyer Six",email:"buyer6@example.org",phone:"+232 78 300 006",password:"SixthBuyerPassword2026!"}});
  const sixthOrder=await api("/api/orders",{method:"POST",cookie:sixthBuyer.cookie,body:{name:"Buyer Six",email:"buyer6@example.org",phone:"+232 78 300 006",address:"Market Street",city:"Bo",paymentMethod:"cash_on_delivery",items:[{productId:usdProduct.data.product.id,quantity:1}]}});assert.equal(sixthOrder.data.order.freeDelivery,false);
  assert.equal((await api("/api/orders",{method:"POST",cookie:buyer.cookie,body:{name:"Test Buyer",email:"buyer@example.org",phone:"+232 76 000 000",address:"12 Wilkinson Road",city:"Freetown",paymentMethod:"cash_on_delivery",items:[{productId:product.data.product.id,quantity:1},{productId:usdProduct.data.product.id,quantity:1}]}})).status,400);
  const delivered=await api(`/api/vendor/orders/${order.data.order.id}`,{method:"PATCH",cookie:vendor.cookie,body:{status:"delivered"}});assert.equal(delivered.data.order.paymentStatus,"pending");assert.equal(delivered.data.order.items.length,1);assert.equal(delivered.data.order.gross,500);
  const beforeAllDelivery=await api("/api/vendor/summary",{cookie:vendor.cookie});assert.equal(beforeAllDelivery.data.balances.SLE||0,0);
  const delivered2=await api(`/api/vendor/orders/${order.data.order.id}`,{method:"PATCH",cookie:vendor2.cookie,body:{status:"delivered"}});assert.equal(delivered2.data.order.paymentStatus,"paid");
  const summary=await api("/api/vendor/summary",{cookie:vendor.cookie});assert.equal(summary.data.balances.SLE,475);assert.equal(summary.data.commissionPercent,5);assert.equal(summary.data.orders[0].items.length,1);
  const usdOrder=await api("/api/orders",{method:"POST",cookie:buyer.cookie,body:{name:"Test Buyer",email:"buyer@example.org",phone:"+232 76 000 000",address:"12 Wilkinson Road",city:"Freetown",paymentMethod:"cash_on_delivery",items:[{productId:usdProduct.data.product.id,quantity:1}]}});
  await api(`/api/vendor/orders/${usdOrder.data.order.id}`,{method:"PATCH",cookie:vendor2.cookie,body:{status:"delivered"}});
  const onlineFailure=await api("/api/orders",{method:"POST",cookie:buyer.cookie,body:{name:"Test Buyer",email:"buyer@example.org",phone:"+232 76 000 000",address:"12 Wilkinson Road",city:"Freetown",paymentMethod:"card",items:[{productId:product.data.product.id,quantity:1}]}});assert.equal(onlineFailure.status,503);
  const afterOnlineFailure=await api("/api/vendor/summary",{cookie:vendor.cookie});assert.equal(afterOnlineFailure.data.products.find(item=>item.id===product.data.product.id).stock,2);
  const webhook=await fetch(`${origin}/api/flutterwave/webhook`,{method:"POST",headers:{"Content-Type":"application/json","verif-hash":"invalid"},body:JSON.stringify({event:"charge.completed",data:{id:1,tx_ref:"missing"}})});assert.equal(webhook.status,401);
  assert.equal((await fetch(`${origin}/server.mjs`)).status,404);
  const payout=await api("/api/vendor/payouts",{method:"POST",cookie:vendor.cookie,body:{amount:100,currency:"SLE",method:"orange_money",destination:"+232 76 111 222"}});assert.equal(payout.status,201);
  const overdraw=await api("/api/vendor/payouts",{method:"POST",cookie:vendor.cookie,body:{amount:400,currency:"SLE",method:"afrimoney",destination:"+232 77 222 333"}});assert.equal(overdraw.status,409);
  const stats=await api("/api/admin/overview",{cookie:admin.cookie}),sllSales=stats.data.stats.sales.find(sale=>sale.currency==="SLE"),usdSales=stats.data.stats.sales.find(sale=>sale.currency==="USD");assert.equal(sllSales.gross,600);assert.equal(sllSales.commission,30);assert.equal(usdSales.gross,20);assert.equal(usdSales.commission,1);
  assert.equal((await api("/api/admin/settings/commission",{method:"PATCH",cookie:admin.cookie,body:{percentage:7}})).status,200);
  assert.equal((await api("/api/admin/settings/commission",{method:"PATCH",cookie:admin.cookie,body:{percentage:12}})).status,400);
  assert.equal((await api("/api/admin/settings/commission",{method:"PATCH",cookie:admin.cookie,requestOrigin:"https://untrusted.example",body:{percentage:8}})).status,403);
  const db=new DatabaseSync(databasePath);assert.equal(db.prepare("SELECT status FROM orders WHERE id=?").get(order.data.order.id).status,"delivered");db.close();
});
