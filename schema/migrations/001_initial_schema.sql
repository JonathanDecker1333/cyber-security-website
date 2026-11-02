CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  store_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  fee_percent DOUBLE PRECISION,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'approved',
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_activity BIGINT NOT NULL
);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  vendor_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  price DOUBLE PRECISION NOT NULL,
  currency TEXT NOT NULL,
  stock INTEGER NOT NULL,
  image TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX product_vendor_idx ON products(vendor_id, active);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO settings(key, value) VALUES('commission_percent', '5')
ON CONFLICT(key) DO NOTHING;

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES users(id),
  customer_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  address TEXT NOT NULL,
  city TEXT NOT NULL,
  currency TEXT NOT NULL,
  gross DOUBLE PRECISION NOT NULL,
  commission DOUBLE PRECISION NOT NULL,
  vendor_net DOUBLE PRECISION NOT NULL,
  payment_method TEXT NOT NULL,
  payment_status TEXT NOT NULL,
  status TEXT NOT NULL,
  tx_ref TEXT UNIQUE,
  free_delivery INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  vendor_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price DOUBLE PRECISION NOT NULL,
  currency TEXT NOT NULL,
  commission DOUBLE PRECISION NOT NULL,
  vendor_net DOUBLE PRECISION NOT NULL,
  fulfillment_status TEXT NOT NULL DEFAULT 'placed'
);
CREATE INDEX order_item_vendor_idx ON order_items(vendor_id, order_id);

CREATE TABLE payouts (
  id TEXT PRIMARY KEY,
  vendor_id TEXT NOT NULL REFERENCES users(id),
  amount DOUBLE PRECISION NOT NULL,
  currency TEXT NOT NULL,
  method TEXT NOT NULL,
  destination TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE contact_messages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  topic TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE vendor_promotions (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  slot INTEGER NOT NULL UNIQUE,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE delivery_promotions (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  status TEXT NOT NULL CHECK(status IN ('reserved', 'redeemed')),
  claimed_at BIGINT NOT NULL
);
