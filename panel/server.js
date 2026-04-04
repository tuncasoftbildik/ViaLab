const express = require('express');
const http = require('http');
const {Server} = require('socket.io');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const {createClient} = require('@libsql/client');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {origin: '*'},
});

// Turso DB (konum geçmişi)
const db = createClient({
  url: process.env.TURSO_URL || 'libsql://viago-panel-tuncasoftbildik.aws-eu-west-1.turso.io',
  authToken: process.env.TURSO_AUTH_TOKEN || '',
});

// Booking.com API ayarları (Render environment variables)
const BOOKING_API_BASE = process.env.BOOKING_API_BASE || 'https://dispatchapi.taxi.booking.com';
const OAUTH_TOKEN_URL = process.env.OAUTH_TOKEN_URL || 'https://auth.dispatchapi.taxi.booking.com/oauth2/token';
const CLIENT_ID = process.env.BOOKING_CLIENT_ID || '';
const CLIENT_SECRET = process.env.BOOKING_CLIENT_SECRET || '';

// Gmail SMTP (Nodemailer)
const mailTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER || 'info@viagotransfer.com',
    pass: process.env.GMAIL_APP_PASSWORD || '',
  },
});

// Multi-Admin sistemi — Turso DB
const panelSessions = new Map(); // token -> {email, role, name}

// Admin tablosu oluştur (yoksa)
db.execute(`CREATE TABLE IF NOT EXISTS panel_admins (
  email TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_by TEXT,
  created_at INTEGER,
  last_login INTEGER
)`).then(() => {
  // Süper admin yoksa oluştur
  const defaultHash = hashPassword('Tunca123');
  db.execute({
    sql: `INSERT OR IGNORE INTO panel_admins (email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?)`,
    args: ['info@viagotransfer.com', defaultHash, 'Tunca', 'superadmin', Date.now()],
  });
}).catch(e => console.log('Admin tablo hatası:', e.message));

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Session'dan admin bilgisi al
function getSession(req) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  return token && panelSessions.has(token) ? panelSessions.get(token) : null;
}

// Panel login
app.post('/api/panel-login', async (req, res) => {
  const {email, password} = req.body;
  if (!email || !password) return res.status(400).json({error: 'Email ve şifre gerekli'});

  try {
    const result = await db.execute({
      sql: 'SELECT email, password_hash, name, role FROM panel_admins WHERE email = ?',
      args: [email],
    });
    if (result.rows.length === 0) return res.status(401).json({error: 'Email veya şifre hatalı'});

    const admin = result.rows[0];
    if (admin.password_hash !== hashPassword(password)) {
      return res.status(401).json({error: 'Email veya şifre hatalı'});
    }

    const token = generateSessionToken();
    panelSessions.set(token, {email: admin.email, role: admin.role, name: admin.name});

    // Son giriş zamanını güncelle
    db.execute({sql: 'UPDATE panel_admins SET last_login = ? WHERE email = ?', args: [Date.now(), email]}).catch(() => {});

    res.json({success: true, token, name: admin.name, role: admin.role});
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

// Panel session doğrulama
app.get('/api/panel-verify', (req, res) => {
  const session = getSession(req);
  if (session) {
    res.json({valid: true, name: session.name, role: session.role});
  } else {
    res.status(401).json({valid: false});
  }
});

// Panel logout
app.post('/api/panel-logout', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) panelSessions.delete(token);
  res.json({success: true});
});

// ============================================
// Admin Yönetimi (sadece superadmin)
// ============================================

// Admin listesi
app.get('/api/panel-admins', async (req, res) => {
  const session = getSession(req);
  if (!session || session.role !== 'superadmin') return res.status(403).json({error: 'Yetkiniz yok'});

  try {
    const result = await db.execute('SELECT email, name, role, created_at, last_login FROM panel_admins ORDER BY created_at ASC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

// Admin ekle
app.post('/api/panel-admins', async (req, res) => {
  const session = getSession(req);
  if (!session || session.role !== 'superadmin') return res.status(403).json({error: 'Yetkiniz yok'});

  const {email, password, name, role} = req.body;
  if (!email || !password || !name) return res.status(400).json({error: 'Email, şifre ve isim gerekli'});
  if (password.length < 6) return res.status(400).json({error: 'Şifre en az 6 karakter olmalı'});
  if (!['admin', 'viewer'].includes(role)) return res.status(400).json({error: 'Geçersiz rol'});

  try {
    await db.execute({
      sql: 'INSERT INTO panel_admins (email, password_hash, name, role, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      args: [email, hashPassword(password), name, role, session.email, Date.now()],
    });
    res.status(201).json({success: true});
  } catch (error) {
    if (error.message?.includes('UNIQUE') || error.message?.includes('PRIMARY')) {
      return res.status(409).json({error: 'Bu email zaten kayıtlı'});
    }
    res.status(500).json({error: error.message});
  }
});

// Admin şifre güncelle
app.put('/api/panel-admins/:email/password', async (req, res) => {
  const session = getSession(req);
  if (!session || session.role !== 'superadmin') return res.status(403).json({error: 'Yetkiniz yok'});

  const {password} = req.body;
  if (!password || password.length < 6) return res.status(400).json({error: 'Şifre en az 6 karakter olmalı'});

  try {
    const result = await db.execute({sql: 'UPDATE panel_admins SET password_hash = ? WHERE email = ?', args: [hashPassword(password), req.params.email]});
    if (result.rowsAffected === 0) return res.status(404).json({error: 'Admin bulunamadı'});
    // Mevcut session'ları temizle
    for (const [token, s] of panelSessions) { if (s.email === req.params.email) panelSessions.delete(token); }
    res.json({success: true});
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

// Admin rol güncelle
app.put('/api/panel-admins/:email/role', async (req, res) => {
  const session = getSession(req);
  if (!session || session.role !== 'superadmin') return res.status(403).json({error: 'Yetkiniz yok'});
  if (req.params.email === session.email) return res.status(400).json({error: 'Kendi rolünüzü değiştiremezsiniz'});

  const {role} = req.body;
  if (!['admin', 'viewer', 'superadmin'].includes(role)) return res.status(400).json({error: 'Geçersiz rol'});

  try {
    await db.execute({sql: 'UPDATE panel_admins SET role = ? WHERE email = ?', args: [role, req.params.email]});
    // Session'daki rolü güncelle
    for (const [, s] of panelSessions) { if (s.email === req.params.email) s.role = role; }
    res.json({success: true});
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

// Admin sil
app.delete('/api/panel-admins/:email', async (req, res) => {
  const session = getSession(req);
  if (!session || session.role !== 'superadmin') return res.status(403).json({error: 'Yetkiniz yok'});
  if (req.params.email === session.email) return res.status(400).json({error: 'Kendinizi silemezsiniz'});

  try {
    const result = await db.execute({sql: 'DELETE FROM panel_admins WHERE email = ?', args: [req.params.email]});
    if (result.rowsAffected === 0) return res.status(404).json({error: 'Admin bulunamadı'});
    // Session'ları temizle
    for (const [token, s] of panelSessions) { if (s.email === req.params.email) panelSessions.delete(token); }
    res.json({success: true});
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

let accessToken = null;
let tokenExpiresAt = 0;

// Token al
async function getToken() {
  if (accessToken && Date.now() < tokenExpiresAt) return accessToken;

  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  accessToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return accessToken;
}

// Turso: email alanını ekle (yoksa)
db.execute('ALTER TABLE driver_passwords ADD COLUMN email TEXT').catch(() => {});

// Hoşgeldin maili gönder
async function sendWelcomeEmail(email, firstName, lastName, phone) {
  if (!email || !process.env.GMAIL_APP_PASSWORD) return;
  try {
    await mailTransporter.sendMail({
      from: `"ViaGo Transfer" <${process.env.GMAIL_USER || 'info@viagotransfer.com'}>`,
      to: email,
      subject: 'ViaGo Driver - Hoş Geldiniz!',
      html: `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f7fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="max-width:520px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
  <div style="background:linear-gradient(135deg,#E53935,#C62828);padding:32px;text-align:center">
    <h1 style="color:#fff;margin:0;font-size:24px;font-weight:800">ViaGo Driver</h1>
    <p style="color:rgba(255,255,255,0.9);margin:8px 0 0;font-size:14px">Booking.com Taxi Supplier</p>
  </div>
  <div style="padding:32px">
    <h2 style="color:#1a1a2e;margin:0 0 16px;font-size:20px">Hoş Geldiniz, ${firstName} ${lastName}!</h2>
    <p style="color:#555;font-size:14px;line-height:1.6;margin:0 0 24px">
      ViaGo Driver uygulamasına kaydınız başarıyla tamamlandı. Aşağıdaki bilgilerinizle uygulamaya giriş yapabilirsiniz.
    </p>
    <div style="background:#f8f9fb;border-radius:12px;padding:20px;margin-bottom:24px">
      <div style="margin-bottom:12px">
        <div style="font-size:11px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Telefon Numarası</div>
        <div style="font-size:16px;font-weight:700;color:#1a1a2e">${phone}</div>
      </div>
      <div>
        <div style="font-size:11px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Şifre</div>
        <div style="font-size:16px;font-weight:700;color:#E53935">123456</div>
      </div>
    </div>
    <div style="background:#FFF3E0;border-radius:8px;padding:12px 16px;margin-bottom:24px">
      <p style="color:#E65100;font-size:12px;margin:0;font-weight:600">⚠️ Güvenliğiniz için giriş yaptıktan sonra şifrenizi değiştirmenizi öneriyoruz.</p>
    </div>
    <p style="color:#555;font-size:14px;line-height:1.6;margin:0">
      Uygulamayı App Store'dan indirip hemen kullanmaya başlayabilirsiniz. Herhangi bir sorunuz olursa bizimle iletişime geçmekten çekinmeyin.
    </p>
  </div>
  <div style="background:#f8f9fb;padding:20px;text-align:center;border-top:1px solid #eee">
    <p style="color:#999;font-size:12px;margin:0">© ${new Date().getFullYear()} ViaGo Transfer — info@viagotransfer.com</p>
  </div>
</div>
</body></html>`,
    });
    console.log(`Hoşgeldin maili gönderildi: ${email}`);
  } catch (error) {
    console.log('Mail gönderme hatası:', error.message);
  }
}

// Toplu/tekil mail gönder
async function sendEmailToDriver(email, subject, htmlBody) {
  if (!email || !process.env.GMAIL_APP_PASSWORD) return false;
  try {
    await mailTransporter.sendMail({
      from: `"ViaGo Transfer" <${process.env.GMAIL_USER || 'info@viagotransfer.com'}>`,
      to: email,
      subject,
      html: htmlBody,
    });
    return true;
  } catch (error) {
    console.log('Mail hatası:', error.message);
    return false;
  }
}

// Booking'leri çek ve sürücülere eşle
let driverBookings = new Map(); // phone -> next booking

async function fetchBookings() {
  try {
    const token = await getToken();
    const res = await fetch(`${BOOKING_API_BASE}/v1/bookings?status=NEW,ACCEPTED,DRIVER_ASSIGNED&size=500`, {
      headers: {Authorization: token},
    });
    const data = await res.json();
    const bookings = data?.bookings || data || [];

    // Sürücü telefonuna göre en yakın booking'i bul
    const driverMap = new Map();
    const now = Date.now();

    bookings.forEach(b => {
      const phone = b.driver_assigned?.telephone_number;
      if (!phone) return;

      const pickupTime = new Date(b.pickup_date_time).getTime();
      const diff = pickupTime - now;

      // Sadece gelecekteki veya son 2 saatteki transferleri al
      if (diff < -2 * 3600000) return;

      if (!driverMap.has(phone) || Math.abs(diff) < Math.abs(new Date(driverMap.get(phone).pickup_date_time).getTime() - now)) {
        driverMap.set(phone, b);
      }
    });

    driverBookings = driverMap;
    console.log(`${driverBookings.size} sürücüye booking eşlendi`);
  } catch (error) {
    console.log('Booking çekme hatası:', error.message);
  }
}

// Başlangıçta ve her 60 saniyede booking'leri güncelle
fetchBookings();
setInterval(fetchBookings, 60000);

// Sürücü verileri
const drivers = new Map();
const driverSockets = new Map();
// Sürücü konum güncelleme
app.post('/api/location', (req, res) => {
  const {driverId, firstName, lastName, phone, latitude, longitude, speed, heading, timestamp} = req.body;

  if (!driverId || latitude === undefined || longitude === undefined) {
    return res.status(400).json({error: 'driverId, latitude, longitude gerekli'});
  }

  const driverData = {
    driverId,
    firstName: firstName || '',
    lastName: lastName || '',
    phone: phone || '',
    latitude,
    longitude,
    speed: speed || 0,
    heading: heading || 0,
    timestamp: timestamp || new Date().toISOString(),
    lastUpdate: Date.now(),
    online: true,
  };

  drivers.set(driverId, driverData);

  // Konum geçmişini Turso'ya kaydet
  db.execute({
    sql: 'INSERT INTO driver_locations (driver_id, latitude, longitude, speed, heading, timestamp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    args: [driverId, latitude, longitude, speed || 0, heading || 0, driverData.timestamp, Date.now()],
  }).catch(err => console.log('DB kayıt hatası:', err.message));

  io.to('panel').emit('driverUpdate', driverData);
  res.json({success: true});
});

// Sürücü konum geçmişi (Turso'dan)
app.get('/api/driver-track/:driverId', async (req, res) => {
  try {
    const driverId = req.params.driverId;
    const days = parseInt(req.query.days) || 1; // varsayılan 1 gün, max 30
    const cutoff = Date.now() - Math.min(days, 30) * 24 * 3600000;

    const result = await db.execute({
      sql: 'SELECT latitude as lat, longitude as lng, speed, heading, timestamp, created_at as ts FROM driver_locations WHERE driver_id = ? AND created_at > ? ORDER BY created_at ASC',
      args: [driverId, cutoff],
    });

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

// Tüm sürücüleri getir
app.get('/api/drivers', (req, res) => {
  const driverList = Array.from(drivers.values());
  const now = Date.now();
  // Her zaman lastUpdate'e göre online durumunu belirle (socket disconnect override'ını düzelt)
  driverList.forEach(d => {
    d.online = (now - d.lastUpdate) <= 2 * 60 * 1000;
  });
  res.json(driverList);
});

// Sürücünün sıradaki işini getir
app.get('/api/driver-booking/:phone', (req, res) => {
  const phone = req.params.phone;
  const booking = driverBookings.get(phone);
  if (booking) {
    res.json({
      found: true,
      passengerName: `${booking.passenger?.title || ''} ${booking.passenger?.name || ''}`.trim(),
      passengerPhone: booking.passenger?.telephone_number || '',
      pickup: booking.pickup?.establishment_name || booking.pickup?.address || '',
      pickupType: booking.pickup?.type || '',
      dropoff: booking.dropoff?.establishment_name || booking.dropoff?.address || '',
      pickupTime: booking.pickup_date_time,
      status: booking.status,
      vehicleType: booking.vehicle_type,
      passengerCount: booking.passenger_count,
      flightNumber: booking.flight_number || '',
      meetAndGreet: booking.meet_and_greet || false,
    });
  } else {
    res.json({found: false});
  }
});

// Tüm booking'leri getir (panel için)
app.get('/api/bookings', async (req, res) => {
  try {
    const token = await getToken();
    const apiRes = await fetch(`${BOOKING_API_BASE}/v1/bookings?status=NEW,ACCEPTED,DRIVER_ASSIGNED&size=500`, {
      headers: {Authorization: token},
    });
    const data = await apiRes.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

// Sürücü geçmişi — telefon numarasına göre tüm booking'leri getir
app.get('/api/driver-history/:phone', async (req, res) => {
  try {
    const token = await getToken();
    const phone = req.params.phone;
    const statuses = 'NEW,ACCEPTED,DRIVER_ASSIGNED,COMPLETED,CANCELLED,NO_SHOW';
    const apiRes = await fetch(`${BOOKING_API_BASE}/v1/bookings?status=${statuses}&size=500`, {
      headers: {Authorization: token},
    });
    const data = await apiRes.json();
    const bookings = data?.bookings || data || [];

    // Sürücüye atanmış olanları filtrele
    const driverBookings = bookings.filter(b =>
      b.driver_assigned?.telephone_number === phone
    );

    // Tarihe göre sırala (en yeni önce)
    driverBookings.sort((a, b) =>
      new Date(b.pickup_date_time).getTime() - new Date(a.pickup_date_time).getTime()
    );

    res.json(driverBookings);
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

// ============================================
// Şifre Yönetimi
// ============================================

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// Sürücü login (uygulama kullanır)
app.post('/api/login', async (req, res) => {
  const {phone, password} = req.body;
  if (!phone || !password) {
    return res.status(400).json({error: 'Telefon ve şifre gerekli'});
  }

  try {
    // Şifreyi DB'den kontrol et
    const result = await db.execute({
      sql: 'SELECT password_hash FROM driver_passwords WHERE phone = ?',
      args: [phone],
    });

    if (result.rows.length === 0) {
      return res.status(401).json({error: 'Bu numaraya kayıtlı şifre bulunamadı'});
    }

    const storedHash = result.rows[0].password_hash;
    if (hashPassword(password) !== storedHash) {
      return res.status(401).json({error: 'Şifre yanlış'});
    }

    // Booking.com API'den sürücü bilgilerini getir
    const token = await getToken();
    const apiRes = await fetch(`${BOOKING_API_BASE}/v1/drivers`, {
      headers: {Authorization: token},
    });
    const data = await apiRes.json();
    const drivers = data?.drivers || data || [];
    const driver = drivers.find(d => d.telephone_number === phone);

    if (!driver) {
      return res.status(404).json({error: 'Booking.com sisteminde sürücü bulunamadı'});
    }

    res.json({success: true, driver});
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

// Şifre belirle/güncelle (panel kullanır)
app.post('/api/driver-password', async (req, res) => {
  const {phone, password, email} = req.body;
  if (!phone || !password) {
    return res.status(400).json({error: 'Telefon ve şifre gerekli'});
  }
  if (password.length < 4) {
    return res.status(400).json({error: 'Şifre en az 4 karakter olmalı'});
  }

  try {
    if (email !== undefined) {
      await db.execute({
        sql: 'INSERT OR REPLACE INTO driver_passwords (phone, password_hash, created_at, email) VALUES (?, ?, ?, ?)',
        args: [phone, hashPassword(password), Date.now(), email || null],
      });
    } else {
      await db.execute({
        sql: 'INSERT OR REPLACE INTO driver_passwords (phone, password_hash, created_at) VALUES (?, ?, ?)',
        args: [phone, hashPassword(password), Date.now()],
      });
    }
    res.json({success: true});
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

// Email güncelle
app.post('/api/driver-email', async (req, res) => {
  const {phone, email} = req.body;
  if (!phone || !email) return res.status(400).json({error: 'Telefon ve email gerekli'});
  try {
    await db.execute({sql: 'UPDATE driver_passwords SET email = ? WHERE phone = ?', args: [email, phone]});
    res.json({success: true});
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

// Sürücü email listesi (panel bildirim için)
app.get('/api/driver-emails', async (req, res) => {
  try {
    const result = await db.execute('SELECT phone, email FROM driver_passwords WHERE email IS NOT NULL AND email != \'\'');
    res.json(result.rows);
  } catch (error) {
    // email kolonu yoksa boş dön
    res.json([]);
  }
});

// Email bildirim gönder
app.post('/api/send-email', async (req, res) => {
  const {phone, subject, message} = req.body;
  if (!subject || !message) return res.status(400).json({error: 'Konu ve mesaj gerekli'});

  try {
    let targets = [];
    if (phone) {
      // Tek sürücüye
      const result = await db.execute({sql: 'SELECT phone, email FROM driver_passwords WHERE phone = ? AND email IS NOT NULL', args: [phone]});
      targets = result.rows;
    } else {
      // Tüm sürücülere
      const result = await db.execute('SELECT phone, email FROM driver_passwords WHERE email IS NOT NULL AND email != ""');
      targets = result.rows;
    }

    if (targets.length === 0) return res.status(404).json({error: 'Email adresi bulunamadı'});

    const htmlBody = `
<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f7fa;font-family:-apple-system,sans-serif">
<div style="max-width:520px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
  <div style="background:linear-gradient(135deg,#E53935,#C62828);padding:24px;text-align:center">
    <h1 style="color:#fff;margin:0;font-size:20px;font-weight:800">ViaGo Driver</h1>
  </div>
  <div style="padding:28px">
    <h2 style="color:#1a1a2e;margin:0 0 16px;font-size:18px">${subject}</h2>
    <p style="color:#555;font-size:14px;line-height:1.7;margin:0;white-space:pre-line">${message}</p>
  </div>
  <div style="background:#f8f9fb;padding:16px;text-align:center;border-top:1px solid #eee">
    <p style="color:#999;font-size:11px;margin:0">© ${new Date().getFullYear()} ViaGo Transfer — info@viagotransfer.com</p>
  </div>
</div></body></html>`;

    let sent = 0;
    for (const t of targets) {
      if (await sendEmailToDriver(t.email, subject, htmlBody)) sent++;
    }

    res.json({success: true, sent, total: targets.length});
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

// ============================================
// Sürücü Yönetimi (Booking.com API)
// ============================================

// Booking.com API'den tüm sürücüleri getir
app.get('/api/booking-drivers', async (req, res) => {
  try {
    const token = await getToken();
    const apiRes = await fetch(`${BOOKING_API_BASE}/v1/drivers`, {
      headers: {Authorization: token},
    });
    const data = await apiRes.json();
    res.json(data?.drivers || data || []);
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

// Yeni sürücü oluştur
app.post('/api/booking-drivers', async (req, res) => {
  try {
    const {first_name, last_name, telephone_number, email} = req.body;
    if (!first_name || !last_name || !telephone_number) {
      return res.status(400).json({error: 'Ad, soyad ve telefon gerekli'});
    }

    const token = await getToken();
    const apiRes = await fetch(`${BOOKING_API_BASE}/v1/drivers`, {
      method: 'POST',
      headers: {
        Authorization: token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        first_name,
        last_name,
        telephone_number,
        supplier_location_ids: ['107939'],
      }),
    });

    const data = await apiRes.json();
    if (apiRes.status === 201) {
      // Email varsa Turso'ya kaydet ve hoşgeldin maili gönder
      if (email) {
        await db.execute({
          sql: 'UPDATE driver_passwords SET email = ? WHERE phone = ?',
          args: [email, telephone_number],
        }).catch(() => {});
        sendWelcomeEmail(email, first_name, last_name, telephone_number);
      }
      res.status(201).json(data);
    } else if (apiRes.status === 409) {
      res.status(409).json({error: 'Bu telefon numarasıyla kayıtlı sürücü zaten var'});
    } else {
      res.status(apiRes.status).json(data);
    }
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

// Sürücü sil
app.delete('/api/booking-drivers/:driverId', async (req, res) => {
  try {
    const token = await getToken();
    const apiRes = await fetch(`${BOOKING_API_BASE}/v1/drivers/${req.params.driverId}`, {
      method: 'DELETE',
      headers: {Authorization: token},
    });

    if (apiRes.status === 200) {
      res.json({success: true});
    } else {
      const data = await apiRes.json().catch(() => ({}));
      res.status(apiRes.status).json(data);
    }
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

// ============================================
// Isı Haritası — pickup/dropoff koordinatları
// ============================================
app.get('/api/heatmap', async (req, res) => {
  try {
    const token = await getToken();
    const statuses = 'NEW,ACCEPTED,DRIVER_ASSIGNED,COMPLETED';
    const apiRes = await fetch(`${BOOKING_API_BASE}/v1/bookings?status=${statuses}&size=500`, {
      headers: {Authorization: token},
    });
    const data = await apiRes.json();
    const bookings = data?.bookings || data || [];

    const points = [];
    bookings.forEach(b => {
      if (b.pickup?.latitude && b.pickup?.longitude) {
        points.push({lat: b.pickup.latitude, lng: b.pickup.longitude, type: 'pickup'});
      }
      if (b.dropoff?.latitude && b.dropoff?.longitude) {
        points.push({lat: b.dropoff.latitude, lng: b.dropoff.longitude, type: 'dropoff'});
      }
    });
    res.json(points);
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

// ============================================
// Sürücü Performans
// ============================================
app.get('/api/driver-stats/:phone', async (req, res) => {
  try {
    const token = await getToken();
    const phone = req.params.phone;
    const statuses = 'NEW,ACCEPTED,DRIVER_ASSIGNED,COMPLETED,CANCELLED,NO_SHOW';
    const apiRes = await fetch(`${BOOKING_API_BASE}/v1/bookings?status=${statuses}&size=500`, {
      headers: {Authorization: token},
    });
    const data = await apiRes.json();
    const bookings = data?.bookings || data || [];

    const mine = bookings.filter(b => b.driver_assigned?.telephone_number === phone);
    const completed = mine.filter(b => b.status === 'COMPLETED').length;
    const cancelled = mine.filter(b => b.status === 'CANCELLED').length;
    const noShow = mine.filter(b => b.status === 'NO_SHOW').length;
    const active = mine.filter(b => ['NEW', 'ACCEPTED', 'DRIVER_ASSIGNED'].includes(b.status)).length;
    const total = mine.length;

    // Bugünkü transferler
    const today = new Date().toISOString().slice(0, 10);
    const todayBookings = mine.filter(b => b.pickup_date_time?.startsWith(today));

    // Konum verilerinden online süre hesapla (bugün)
    const driver = Array.from(drivers.values()).find(d => d.phone === phone);
    let onlineMinutes = 0;
    if (driver) {
      const todayStart = Date.now() - (new Date().getHours() * 3600000 + new Date().getMinutes() * 60000);
      const trackResult = await db.execute({
        sql: 'SELECT COUNT(*) as cnt FROM driver_locations WHERE driver_id = ? AND created_at > ?',
        args: [driver.driverId, todayStart],
      });
      // Her konum noktası ~30sn aralıkla gelir
      onlineMinutes = Math.round((trackResult.rows[0]?.cnt || 0) * 0.5);
    }

    res.json({
      total, completed, cancelled, noShow, active,
      todayTotal: todayBookings.length,
      todayCompleted: todayBookings.filter(b => b.status === 'COMPLETED').length,
      completionRate: total > 0 ? Math.round((completed / total) * 100) : 0,
      onlineMinutesToday: onlineMinutes,
    });
  } catch (error) {
    res.status(500).json({error: error.message});
  }
});

// ============================================
// Canlı Transfer Takibi (yolcu linki)
// ============================================
app.get('/api/track/:phone', (req, res) => {
  const phone = req.params.phone;
  const driver = Array.from(drivers.values()).find(d => d.phone === phone);
  const booking = driverBookings.get(phone);

  res.send(`<!DOCTYPE html>
<html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ViaGo Transfer Takip</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,sans-serif;background:#f5f5f5}
#map{height:60vh;width:100%}
.info{padding:16px;background:#fff;border-radius:16px 16px 0 0;margin-top:-16px;position:relative;z-index:400}
.driver-name{font-size:18px;font-weight:800;color:#1a1a2e}
.detail{font-size:13px;color:#666;margin-top:4px;display:flex;align-items:center;gap:6px}
.badge{display:inline-block;font-size:11px;font-weight:700;padding:3px 10px;border-radius:12px;color:#fff;background:#43A047}
.route{margin-top:12px;padding:12px;background:#f9f9f9;border-radius:12px}
.route-point{display:flex;align-items:center;gap:8px;font-size:13px;padding:4px 0}
.dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.line{width:2px;height:16px;background:#ddd;margin-left:4px}
</style>
</head><body>
<div id="map"></div>
<div class="info">
  ${driver ? `
    <div class="driver-name">${driver.firstName} ${driver.lastName}</div>
    <div class="detail"><span class="badge">${driver.online ? 'Yolda' : 'Bekleniyor'}</span> ${Math.round(driver.speed)} km/s</div>
  ` : '<div class="driver-name">Sürücü bilgisi bekleniyor...</div>'}
  ${booking ? `
    <div class="route">
      <div class="route-point"><div class="dot" style="background:#43A047"></div> ${booking.pickup?.establishment_name || booking.pickup?.address || ''}</div>
      <div style="margin-left:4px"><div class="line"></div></div>
      <div class="route-point"><div class="dot" style="background:#E53935"></div> ${booking.dropoff?.establishment_name || booking.dropoff?.address || ''}</div>
    </div>
  ` : ''}
</div>
<script>
const map=L.map('map').setView([${driver ? `${driver.latitude},${driver.longitude}` : '41.0082,28.9784'}],14);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(map);
${driver ? `
let marker=L.marker([${driver.latitude},${driver.longitude}],{
  icon:L.divIcon({className:'',html:'<div style="width:32px;height:32px;border-radius:50%;background:#43A047;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;color:#fff;font-size:16px">🚗</div>',iconSize:[32,32],iconAnchor:[16,16]})
}).addTo(map);
setInterval(async()=>{
  try{
    const r=await fetch('/api/drivers');
    const all=await r.json();
    const d=all.find(x=>x.phone==='${phone}');
    if(d){marker.setLatLng([d.latitude,d.longitude]);map.panTo([d.latitude,d.longitude])}
  }catch(e){}
},10000);
` : ''}
</script>
</body></html>`);
});

// Bildirim gönder
app.post('/api/notify', (req, res) => {
  const {driverId, title, message, type} = req.body;

  if (!title || !message) {
    return res.status(400).json({error: 'title ve message gerekli'});
  }

  const notification = {
    id: Date.now().toString(),
    title,
    message,
    type: type || 'info',
    timestamp: new Date().toISOString(),
    driverId: driverId || null,
  };

  if (driverId) {
    const socket = driverSockets.get(driverId);
    if (socket) socket.emit('notification', notification);
  } else {
    io.to('drivers').emit('notification', notification);
  }

  io.to('panel').emit('notificationSent', notification);
  res.json({success: true, notification});
});

// Socket.IO
io.on('connection', (socket) => {
  console.log('Bağlantı:', socket.id);

  socket.on('joinPanel', () => {
    socket.join('panel');
    console.log('Panel bağlandı:', socket.id);
    socket.emit('allDrivers', Array.from(drivers.values()));
  });

  socket.on('joinDriver', (data) => {
    socket.join('drivers');
    driverSockets.set(data.driverId, socket);
    console.log('Sürücü bağlandı:', data.driverId);

    socket.on('disconnect', () => {
      driverSockets.delete(data.driverId);
      const driver = drivers.get(data.driverId);
      if (driver) {
        // Son 2 dk içinde HTTP konum geldiyse hâlâ online say (socket kopsa bile)
        const isRecentlyActive = (Date.now() - driver.lastUpdate) <= 2 * 60 * 1000;
        if (!isRecentlyActive) {
          driver.online = false;
          io.to('panel').emit('driverUpdate', driver);
        }
      }
      console.log('Sürücü ayrıldı:', data.driverId);
    });
  });

  socket.on('locationUpdate', (data) => {
    const driverData = {
      ...data,
      lastUpdate: Date.now(),
      online: true,
    };
    drivers.set(data.driverId, driverData);
    io.to('panel').emit('driverUpdate', driverData);
  });

  socket.on('disconnect', () => {
    console.log('Bağlantı kesildi:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`ViaGo Panel Server: http://localhost:${PORT}`);
});
