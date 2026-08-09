import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

// Load environment variables
dotenv.config();

const supabaseUrl = process.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY || '';

const isServerSupabaseConfigured = Boolean(
  supabaseUrl && 
  supabaseAnonKey && 
  supabaseUrl.startsWith('http') && 
  !supabaseUrl.includes('YOUR_SUPABASE')
);

const getSupabaseServer = () => {
  if (!isServerSupabaseConfigured) return null;
  return createClient(supabaseUrl, supabaseAnonKey);
};

// In-memory store for simulated payments
interface SimulatedPayment {
  invoice: string;
  amount: number;
  customerName: string;
  customerEmail: string;
  description: string;
  paymentMethod: string;
  status: 'pending' | 'completed';
  createdAt: number;
}

const simulatedPayments = new Map<string, SimulatedPayment>();

async function completeDepositOnServer(txId: string): Promise<boolean> {
  const supabase = getSupabaseServer();
  if (!supabase) {
    console.warn('[Server Supabase] Supabase is not configured on server.');
    return false;
  }

  try {
    // 1. Fetch the transaction
    const { data: tx, error: txError } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', txId)
      .single();

    if (txError || !tx) {
      console.warn(`[Server Supabase] Transaction not found or error for ID: ${txId}`, txError);
      return false;
    }

    // Early return if not pending or already completed
    if (tx.status !== 'pending') {
      console.info(`[Server Supabase] Transaction ${txId} is not in pending status (current: ${tx.status}). Early return.`);
      return true; // Already processed
    }

    // 2. Fetch the profile
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', tx.user_id)
      .single();

    if (profileError || !profile) {
      console.warn(`[Server Supabase] Profile not found for user: ${tx.user_id}`);
      return false;
    }

    // 3. Calculate new balance
    const depositAmount = Number(tx.amount);
    const newBal = Number((Number(profile.real_balance || 0) + depositAmount).toFixed(2));

    // Calculate status tier if needed (fetch all completed deposits of the user)
    const { data: allCompletedTx, error: allTxError } = await supabase
      .from('transactions')
      .select('amount')
      .eq('user_id', tx.user_id)
      .eq('type', 'deposit')
      .eq('status', 'completed');

    let totalCompleted = depositAmount;
    if (!allTxError && allCompletedTx) {
      totalCompleted += allCompletedTx.reduce((sum, item) => sum + Number(item.amount), 0);
    }

    let newTierId = profile.status_tier || 'basic';
    if (totalCompleted >= 15000000) {
      newTierId = 'elite';
    } else if (totalCompleted >= 5000000) {
      newTierId = 'pro';
    } else if (totalCompleted >= 1000000) {
      newTierId = 'smart';
    }

    // 4. Update Profile
    const { error: updateProfileError } = await supabase
      .from('profiles')
      .update({
        real_balance: newBal,
        status_tier: newTierId,
        updated_at: new Date().toISOString()
      })
      .eq('id', tx.user_id);

    if (updateProfileError) {
      console.error('[Server Supabase] Failed to update user profile balance:', updateProfileError);
      return false;
    }

    // 5. Update Transaction
    const { error: updateTxError } = await supabase
      .from('transactions')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString()
      })
      .eq('id', txId);

    if (updateTxError) {
      console.error('[Server Supabase] Failed to update transaction status:', updateTxError);
      return false;
    }

    console.info(`[Server Supabase] Successfully auto-completed transaction ${txId} and added Rp ${depositAmount} to user ${tx.user_id}`);
    return true;
  } catch (err) {
    console.error('[Server Supabase] Exception completing transaction:', err);
    return false;
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Parsers for JSON and URL-encoded forms
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Security Headers Middleware
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  // Simple IP Rate Limiter for API endpoints
  const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
  const apiRateLimiter = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const ip = req.ip || req.headers['x-forwarded-for'] as string || 'unknown';
    const now = Date.now();
    const windowMs = 60 * 1000; // 1 minute
    const maxRequests = 60; // max 60 req/min

    const record = rateLimitMap.get(ip) || { count: 0, resetTime: now + windowMs };
    if (now > record.resetTime) {
      record.count = 1;
      record.resetTime = now + windowMs;
    } else {
      record.count += 1;
    }

    rateLimitMap.set(ip, record);

    if (record.count > maxRequests) {
      return res.status(429).json({
        success: false,
        message: 'Terlalu banyak permintaan (Rate limit exceeded). Silakan coba lagi dalam beberapa saat.'
      });
    }

    next();
  };

  app.use('/api/', apiRateLimiter);

  // SEO Routes: robots.txt and sitemap.xml
  app.get('/robots.txt', (req, res) => {
    res.type('text/plain');
    res.send(`User-agent: *
Allow: /
Disallow: /admin
Disallow: /api/
Disallow: /simulated-payment/

Sitemap: https://beyondtrade.io/sitemap.xml`);
  });

  app.get('/sitemap.xml', (req, res) => {
    res.type('application/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://beyondtrade.io/</loc>
    <lastmod>2026-08-09</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://beyondtrade.io/trade</loc>
    <lastmod>2026-08-09</lastmod>
    <changefreq>always</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>https://beyondtrade.io/education</loc>
    <lastmod>2026-08-09</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://beyondtrade.io/news</loc>
    <lastmod>2026-08-09</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://beyondtrade.io/leaderboard</loc>
    <lastmod>2026-08-09</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>https://beyondtrade.io/wallet</loc>
    <lastmod>2026-08-09</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
  <url>
    <loc>https://beyondtrade.io/acc</loc>
    <lastmod>2026-08-09</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.5</priority>
  </url>
  <url>
    <loc>https://beyondtrade.io/support</loc>
    <lastmod>2026-08-09</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.5</priority>
  </url>
</urlset>`);
  });

  // API: Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: Date.now() });
  });

  // API: Create Bayar.gg Payment (Proxied/Simulated)
  app.post('/api/bayargg/create-payment', async (req, res) => {
    try {
      const {
        amount,
        description,
        customerName,
        customerEmail,
        customerPhone,
        paymentMethod
      } = req.body;

      const amountNum = Number(amount);
      if (isNaN(amountNum) || amountNum <= 0 || !Number.isInteger(amountNum) || amountNum < 500000) {
        return res.status(400).json({
          success: false,
          message: 'Nominal deposit tidak valid. Harus berupa angka bulat positif, minimal Rp 500.000.'
        });
      }

      const apiKey = process.env.BAYAR_GG_API_KEY;

      // If API Key is present and NOT a placeholder, make a live API call
      if (apiKey && apiKey.trim() !== '' && !apiKey.includes('YOUR_')) {
        console.info('[Bayar.gg API] Initiating live payment request...');
        
        // Define redirect and callback URLs relative to the requested host
        const host = req.get('host');
        const protocol = req.protocol;
        const appUrl = `${protocol}://${host}`;

        const payload = {
          amount: Number(amount),
          payment_url: `${appUrl}/wallet`,
          description: description || `Deposit ${amount} IDR`,
          customer_name: customerName || 'Beyond Trade User',
          customer_email: customerEmail || 'user@example.com',
          customer_phone: customerPhone || '',
          payment_method: paymentMethod || 'qris',
          callback_url: `${appUrl}/api/bayargg/callback`,
          redirect_url: `${appUrl}/wallet?tab=history`
        };

        const response = await fetch('https://www.bayar.gg/api/create-payment.php', {
          method: 'POST',
          headers: {
            'X-API-Key': apiKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          const errText = await response.text();
          console.error('[Bayar.gg API] Live creation failed:', errText);
          return res.status(response.status).json({
            success: false,
            message: `Gateway Error: ${errText || 'Gagal membuat pembayaran.'}`
          });
        }

        const data = await response.json();
        return res.json({
          success: true,
          isSimulated: false,
          invoice: data.invoice,
          payment_url: data.payment_url,
          total_amount: data.total_amount || amount,
          qris_payload: data.qris_payload || ''
        });
      } else {
        // Run in Simulated Sandbox Mode
        console.info('[Bayar.gg API] API Key not found or empty. Using Sandbox Simulation Mode.');

        const invoiceId = `INV-BGG-SIM-${Math.floor(100000 + Math.random() * 900000)}`;
        const protocol = req.protocol;
        const host = req.get('host');
        const paymentUrl = `${protocol}://${host}/simulated-payment/${invoiceId}`;

        const simulatedPay: SimulatedPayment = {
          invoice: invoiceId,
          amount: Number(amount),
          customerName: customerName || 'Beyond Trade User',
          customerEmail: customerEmail || 'user@example.com',
          description: description || `Deposit ${amount} IDR (Simulated)`,
          paymentMethod: paymentMethod || 'qris',
          status: 'pending',
          createdAt: Date.now()
        };

        simulatedPayments.set(invoiceId, simulatedPay);

        return res.json({
          success: true,
          isSimulated: true,
          invoice: invoiceId,
          payment_url: paymentUrl,
          total_amount: amount,
          qris_payload: '00020101021226590014ID.CO.QRIS.WWW0118936005200123456789520400005303360541010000005802ID5912BEYOND_TRADE6005MEDAN61052011162070703A016304ABCD'
        });
      }
    } catch (err: any) {
      console.error('[Bayar.gg Endpoint Error]:', err);
      return res.status(500).json({
        success: false,
        message: err.message || 'Internal server error'
      });
    }
  });

  // API: Check Payment Status
  app.get('/api/bayargg/check-payment', async (req, res) => {
    try {
      const { invoice } = req.query;

      if (!invoice) {
        return res.status(400).json({
          success: false,
          message: 'Parameter invoice wajib disertakan.'
        });
      }

      const invoiceStr = invoice as string;
      const apiKey = process.env.BAYAR_GG_API_KEY;

      // If live API mode is active
      if (apiKey && apiKey.trim() !== '' && !apiKey.includes('YOUR_') && !invoiceStr.startsWith('INV-BGG-SIM-')) {
        console.info(`[Bayar.gg API] Checking live payment status for invoice: ${invoiceStr}`);
        
        const response = await fetch(`https://www.bayar.gg/api/check-payment.php?invoice=${invoiceStr}`, {
          method: 'GET',
          headers: {
            'X-API-Key': apiKey
          }
        });

        if (!response.ok) {
          return res.status(response.status).json({
            success: false,
            message: 'Gagal mengecek status pembayaran ke live gateway.'
          });
        }

        const data = await response.json();
        // Typically returns { invoice, status: 'completed' | 'pending' | 'expired', amount, payment_method }
        
        if (data.status === 'completed') {
          // Sync database status & add funds securely on server-side
          await completeDepositOnServer(invoiceStr);
        }

        return res.json({
          success: true,
          status: data.status,
          invoice: data.invoice,
          amount: data.amount
        });
      } else {
        // Simulated Sandbox Mode Status Check
        const payment = simulatedPayments.get(invoiceStr);
        if (!payment) {
          return res.status(404).json({
            success: false,
            message: 'Invoice tidak ditemukan di sandbox.'
          });
        }

        if (payment.status === 'completed') {
          // Sync database status & add funds securely on server-side
          await completeDepositOnServer(invoiceStr);
        }

        return res.json({
          success: true,
          status: payment.status,
          invoice: payment.invoice,
          amount: payment.amount
        });
      }
    } catch (err: any) {
      console.error('[Bayar.gg Status Check Error]:', err);
      return res.status(500).json({
        success: false,
        message: err.message || 'Internal server error'
      });
    }
  });

  // API: Simulate Success Payment
  app.post('/api/bayargg/simulate-pay', async (req, res) => {
    const { invoice } = req.body;
    if (!invoice || typeof invoice !== 'string') {
      return res.status(400).json({ success: false, message: 'Parameter invoice tidak valid.' });
    }

    // Security Guard: Prevent arbitrary invoice string injection or exploitation of real transactions
    if (!invoice.startsWith('INV-BGG-SIM-')) {
      return res.status(403).json({
        success: false,
        message: 'Akses ditolak. Simulasi hanya berlaku untuk transaksi sandbox (INV-BGG-SIM-).'
      });
    }

    const payment = simulatedPayments.get(invoice);
    if (payment) {
      if (payment.status === 'completed') {
        return res.json({ success: true, message: 'Payment already completed.' });
      }
      payment.status = 'completed';
      simulatedPayments.set(invoice, payment);
      console.info(`[Sandbox Gateway] Invoice ${invoice} successfully paid!`);
    }

    // Direct database sync & balance update on server-side
    const syncSuccess = await completeDepositOnServer(invoice);

    return res.json({ 
      success: true, 
      message: 'Payment simulated successfully.',
      syncSuccess
    });
  });

  // Live Webhook Endpoint for Bayar.gg Callbacks
  app.post('/api/bayargg/callback', async (req, res) => {
    console.info('[Bayar.gg API Webhook Received]:', req.body);
    const { invoice, status, reference } = req.body;
    
    const targetInvoice = invoice || reference;
    if (targetInvoice && status === 'completed') {
      const payment = simulatedPayments.get(targetInvoice);
      if (payment) {
        payment.status = 'completed';
        simulatedPayments.set(targetInvoice, payment);
      }
      
      // Persistently and securely update status & add realBalance on the server
      await completeDepositOnServer(targetInvoice);
    }

    res.status(200).send('OK');
  });

  // HTML Route: Serving Simulated Payment Gateway Checkout Screen
  app.get('/simulated-payment/:invoice', (req, res) => {
    const { invoice } = req.params;
    const payment = simulatedPayments.get(invoice);

    if (!payment) {
      return res.status(404).send(`
        <html>
          <head>
            <title>Sandbox - Invoice Not Found</title>
            <script src="https://cdn.tailwindcss.com"></script>
          </head>
          <body class="bg-[#0b0e14] text-white flex items-center justify-center min-h-screen">
            <div class="text-center p-6 bg-[#161a24] border border-red-500/20 rounded-2xl max-w-sm">
              <h1 class="text-red-500 font-black text-xl mb-2">Invoice Tidak Ditemukan</h1>
              <p class="text-xs text-gray-400">Silakan tutup tab ini dan buat permohonan deposit baru di aplikasi trading Anda.</p>
            </div>
          </body>
        </html>
      `);
    }

    const formattedAmount = payment.amount.toLocaleString('id-ID');
    const methodLabel = payment.paymentMethod === 'qris' ? 'QRIS / E-Wallet Instant' : payment.paymentMethod.toUpperCase();

    res.send(`
      <!DOCTYPE html>
      <html lang="id">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Simulasi Gateway Bayar.gg - Secure Checkout</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&family=Space+Grotesk:wght@500;700&display=swap" rel="stylesheet">
        <style>
          body {
            font-family: 'Plus Jakarta Sans', sans-serif;
          }
          .font-mono-custom {
            font-family: 'Space Grotesk', monospace;
          }
        </style>
      </head>
      <body class="bg-[#0d0f17] text-gray-200 min-h-screen flex items-center justify-center p-4">
        <div class="w-full max-w-md bg-[#131722]/90 border border-[#232936] rounded-3xl p-6 sm:p-8 shadow-2xl relative overflow-hidden backdrop-blur-md">
          
          <!-- Background Glow -->
          <div class="absolute -top-24 -left-24 w-48 h-48 bg-amber-500/10 rounded-full blur-3xl pointer-events-none"></div>
          <div class="absolute -bottom-24 -right-24 w-48 h-48 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none"></div>

          <!-- Logo & Sandbox Banner -->
          <div class="flex items-center justify-between mb-6 border-b border-[#232936] pb-5">
            <div class="flex items-center gap-2">
              <div class="w-8 h-8 rounded-xl bg-gradient-to-tr from-amber-500 to-yellow-400 flex items-center justify-center font-black text-slate-950 text-base shadow-lg shadow-amber-500/20">
                B
              </div>
              <div>
                <h1 class="text-sm font-black text-white tracking-tight">bayar<span class="text-amber-500">.gg</span></h1>
                <p class="text-[9px] text-gray-400 font-bold tracking-widest uppercase">Payment Sandbox</p>
              </div>
            </div>
            <span class="text-[9px] font-black tracking-wider bg-amber-500/15 border border-amber-500/30 text-amber-500 px-2.5 py-1 rounded-full uppercase">
              Demo Simulation
            </span>
          </div>

          <!-- Invoice Details Screen -->
          <div id="payment-box" class="space-y-6">
            <div class="space-y-1.5">
              <span class="text-[10px] text-gray-400 font-bold uppercase tracking-wider">Merchant Tujuan</span>
              <div class="text-sm font-black text-white flex items-center gap-1.5">
                <div class="w-4 h-4 bg-emerald-500/20 text-emerald-400 rounded-full flex items-center justify-center text-[9px] font-bold">✓</div>
                Beyond Trade Platform (Verified)
              </div>
            </div>

            <!-- Invoice Card -->
            <div class="bg-[#181d2a] border border-[#232936] p-4.5 rounded-2xl space-y-3">
              <div class="flex justify-between items-center text-xs text-gray-400">
                <span>Kode Invoice</span>
                <span class="font-mono-custom text-white font-bold">${invoice}</span>
              </div>
              <div class="flex justify-between items-center text-xs text-gray-400">
                <span>Deskripsi</span>
                <span class="text-white font-semibold text-right">${payment.description}</span>
              </div>
              <div class="flex justify-between items-center text-xs text-gray-400">
                <span>Metode</span>
                <span class="text-white font-semibold">${methodLabel}</span>
              </div>
              <div class="flex justify-between items-center text-xs text-gray-400">
                <span>Pelanggan</span>
                <span class="text-white font-semibold">${payment.customerName}</span>
              </div>
              <div class="border-t border-[#2d3448] pt-3 flex justify-between items-center">
                <span class="text-xs text-gray-400 font-semibold">Total Nominal</span>
                <span class="text-lg font-black text-amber-400 font-mono-custom">Rp ${formattedAmount}</span>
              </div>
            </div>

            <!-- Simulated QRIS Code Display -->
            <div class="flex flex-col items-center justify-center p-4 bg-white rounded-2xl border border-gray-200">
              <p class="text-[10px] text-gray-500 font-black tracking-widest uppercase mb-2">SCAN QRIS UNTUK BAYAR</p>
              
              <!-- Clean SVG QR Code Representation -->
              <svg class="w-40 h-40" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect width="100" height="100" fill="white"/>
                <!-- Outer Border and Position Markers -->
                <rect x="5" y="5" width="25" height="25" stroke="#12141c" stroke-width="4" fill="none"/>
                <rect x="10" y="10" width="15" height="15" fill="#12141c"/>
                <rect x="70" y="5" width="25" height="25" stroke="#12141c" stroke-width="4" fill="none"/>
                <rect x="75" y="10" width="15" height="15" fill="#12141c"/>
                <rect x="5" y="70" width="25" height="25" stroke="#12141c" stroke-width="4" fill="none"/>
                <rect x="10" y="75" width="15" height="15" fill="#12141c"/>
                
                <!-- Random QR Grid Blocks -->
                <rect x="40" y="10" width="10" height="10" fill="#12141c"/>
                <rect x="55" y="15" width="5" height="15" fill="#12141c"/>
                <rect x="45" y="35" width="15" height="10" fill="#12141c"/>
                <rect x="10" y="45" width="10" height="15" fill="#12141c"/>
                <rect x="40" y="55" width="20" height="5" fill="#12141c"/>
                <rect x="75" y="45" width="15" height="15" fill="#12141c"/>
                <rect x="80" y="75" width="10" height="10" fill="#12141c"/>
                <rect x="45" y="75" width="15" height="15" fill="#12141c"/>
              </svg>
              
              <div class="mt-2.5 flex items-center gap-1.5">
                <span class="text-[9px] font-bold text-gray-500 bg-gray-100 px-2 py-0.5 rounded border border-gray-200">GPN</span>
                <span class="text-[9px] font-bold text-gray-500 bg-gray-100 px-2 py-0.5 rounded border border-gray-200">QRIS</span>
              </div>
            </div>

            <!-- Instructions & Pay Button -->
            <div class="space-y-4">
              <p class="text-[10px] text-gray-400 text-center leading-relaxed">
                Ini adalah portal pembayaran simulasi/sandbox. Mengklik tombol di bawah ini akan memicu respons sukses dan langsung memproses saldo di Beyond Trade.
              </p>
              
              <button
                id="btn-pay"
                onclick="processPayment()"
                class="w-full bg-emerald-500 hover:bg-emerald-600 text-slate-950 font-black text-sm py-3.5 rounded-2xl shadow-lg shadow-emerald-500/20 transition-all hover:scale-[1.01] cursor-pointer"
              >
                BAYAR SEKARANG (SIMULASI SUKSES)
              </button>
            </div>
          </div>

          <!-- Success Celebration Screen -->
          <div id="success-box" class="hidden text-center py-8 space-y-5 animate-in fade-in duration-500">
            <div class="w-20 h-20 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 rounded-full flex items-center justify-center mx-auto shadow-lg shadow-emerald-500/5">
              <svg class="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"></path>
              </svg>
            </div>
            
            <div class="space-y-2">
              <h2 class="text-xl font-black text-white">Pembayaran Berhasil!</h2>
              <p class="text-xs text-gray-400 max-w-xs mx-auto leading-relaxed">
                Invoice <span class="font-mono-custom text-amber-400 font-bold">${invoice}</span> sebesar <strong>Rp ${formattedAmount}</strong> telah sukses dibayarkan di sandbox.
              </p>
            </div>

            <p class="text-[11px] text-emerald-400 font-semibold bg-[#11191e] border border-emerald-500/20 p-3 rounded-xl">
              Kembali ke Beyond Trade Anda. Transaksi Anda akan otomatis terdeteksi sebagai sukses dalam beberapa detik.
            </p>

            <button
              onclick="window.close()"
              class="px-5 py-2 bg-[#181d2a] hover:bg-[#232936] text-white border border-[#2d3448] text-xs font-bold rounded-xl transition-all"
            >
              Tutup Tab Ini
            </button>
          </div>

        </div>

        <script>
          async function processPayment() {
            const btn = document.getElementById('btn-pay');
            btn.disabled = true;
            btn.innerHTML = \`
              <svg class="animate-spin -ml-1 mr-3 h-4 w-4 text-slate-950 inline" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              Memproses Pembayaran...
            \`;

            try {
              const res = await fetch('/api/bayargg/simulate-pay', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({ invoice: '${invoice}' })
              });

              if (res.ok) {
                document.getElementById('payment-box').classList.add('hidden');
                document.getElementById('success-box').classList.remove('hidden');
              } else {
                alert('Gagal mensimulasikan pembayaran.');
                btn.disabled = false;
                btn.innerText = 'BAYAR SEKARANG (SIMULASI SUKSES)';
              }
            } catch (err) {
              console.error(err);
              alert('Terjadi kesalahan koneksi.');
              btn.disabled = false;
              btn.innerText = 'BAYAR SEKARANG (SIMULASI SUKSES)';
            }
          }
        </script>
      </body>
      </html>
    `);
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Beyond Trade Server] Running on http://localhost:${PORT}`);
  });
}

startServer();
