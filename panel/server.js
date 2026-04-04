const express = require('express');
const http = require('http');
const {Server} = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {origin: '*'},
});

// Booking.com API ayarları (Render environment variables)
const BOOKING_API_BASE = process.env.BOOKING_API_BASE || 'https://dispatchapi.taxi.booking.com';
const OAUTH_TOKEN_URL = process.env.OAUTH_TOKEN_URL || 'https://auth.dispatchapi.taxi.booking.com/oauth2/token';
const CLIENT_ID = process.env.BOOKING_CLIENT_ID || '';
const CLIENT_SECRET = process.env.BOOKING_CLIENT_SECRET || '';

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
const driverTracks = new Map(); // driverId -> [{lat, lng, speed, heading, timestamp}]

// Konum geçmişi: 24 saatten eskilerini temizle
function pruneTrack(track) {
  const cutoff = Date.now() - 24 * 3600000;
  while (track.length > 0 && track[0].ts < cutoff) track.shift();
  return track;
}

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

  // Konum geçmişine ekle
  if (!driverTracks.has(driverId)) driverTracks.set(driverId, []);
  const track = driverTracks.get(driverId);
  track.push({
    lat: latitude,
    lng: longitude,
    speed: speed || 0,
    heading: heading || 0,
    ts: Date.now(),
    timestamp: driverData.timestamp,
  });
  pruneTrack(track);

  io.to('panel').emit('driverUpdate', driverData);
  res.json({success: true});
});

// Sürücü konum geçmişi
app.get('/api/driver-track/:driverId', (req, res) => {
  const track = driverTracks.get(req.params.driverId) || [];
  res.json(pruneTrack(track));
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
    const {first_name, last_name, telephone_number} = req.body;
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
