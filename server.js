const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');

const app = express();
const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
app.use(cors({
    origin(origin, callback) {
        if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error('Origin not allowed'));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));
app.use(express.json({ limit: '32kb' }));
app.disable('x-powered-by');

axios.defaults.timeout = 15000;
axios.defaults.maxContentLength = 8 * 1024 * 1024;
axios.defaults.maxBodyLength = 2 * 1024 * 1024;

const BASE_URL = 'https://glb.servergi.com:8071/iSIMGLBMTR';
const LOGIN_URL = `${BASE_URL}/Login`;
const HOME_URL = `${BASE_URL}/home`;
const PROFILE_URL = `${BASE_URL}/Student/Course`;
const ATTENDANCE_URL = `${BASE_URL}/Student/TodayAttendence`;
const TIMETABLE_URL = `${BASE_URL}/Student/TimeTable`;
const PORT = Number(process.env.PORT) || 3000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const AWAKE_PING_INTERVAL_MS = 100 * 1000;
const awake_user = ['26CSAIM197'];
const sessions = new Map();
const rateBuckets = new Map();

function rateLimit(key, limit, windowMs) {
    const now = Date.now();
    let bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.startedAt >= windowMs) {
        bucket = { startedAt: now, count: 0 };
        rateBuckets.set(key, bucket);
    }
    bucket.count += 1;
    return bucket.count <= limit;
}

function createSessionId() {
    return crypto.randomBytes(32).toString('hex');
}

function getSession(sessionId, requireLogin = true) {
    if (typeof sessionId !== 'string' || !/^[a-f0-9]{64}$/i.test(sessionId)) return null;
    const session = sessions.get(sessionId);
    if (!session || (!session.awakeUser && Date.now() - session.lastSeenAt > SESSION_TTL_MS)) {
        sessions.delete(sessionId);
        return null;
    }
    if (requireLogin && !session.loggedIn) return null;
    session.lastSeenAt = Date.now();
    return session;
}

setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
        if (!session.awakeUser && now - session.lastSeenAt > SESSION_TTL_MS) sessions.delete(id);
    }
    for (const [key, bucket] of rateBuckets) {
        if (now - bucket.startedAt > 60 * 60 * 1000) rateBuckets.delete(key);
    }
}, 5 * 60 * 1000).unref();

function mergeCookies(oldCookies = '', newCookieHeaders = []) {
    const map = new Map();
    String(oldCookies).split(';').forEach(part => {
        const item = part.trim();
        if (!item) return;
        const index = item.indexOf('=');
        if (index > 0) map.set(item.slice(0, index), item.slice(index + 1));
    });
    for (const cookie of (newCookieHeaders || [])) {
        const first = String(cookie).split(';')[0];
        const index = first.indexOf('=');
        if (index > 0) map.set(first.slice(0, index).trim(), first.slice(index + 1).trim());
    }
    return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function formatDateForDotNet(dateStr) {
    if (!dateStr) return '';
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) return dateStr;
    const [y, m, d] = dateStr.split('-');
    return `${d}/${m}/${y}`;
}

function cleanText(value) {
    return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function isPortalLoginPage(html) {
    if (typeof html !== 'string') return false;
    return /__txtUserId100|txtPass/.test(html);
}

function sessionExpiredError() {
    const error = new Error('College portal session expired');
    error.code = 'SESSION_EXPIRED';
    return error;
}

function extractFormPayload(html, buttonName, buttonValue, extraFields = {}) {
    const $page = cheerio.load(html);
    const form = $page('form').first();
    const payload = new URLSearchParams();

    form.find('input,select,textarea').each((_, el) => {
        const $el = $page(el);
        const name = $el.attr('name');
        if (!name || $el.is(':disabled')) return;
        const type = ($el.attr('type') || '').toLowerCase();
        if (['submit', 'button', 'image', 'reset', 'file'].includes(type)) return;
        if ((type === 'checkbox' || type === 'radio') && !$el.is(':checked')) return;
        payload.append(name, $el.val() || '');
    });

    for (const [key, value] of Object.entries(extraFields)) payload.set(key, value);
    if (buttonName) payload.set(buttonName, buttonValue);
    return payload;
}

async function fetchAttendancePageHtml(session) {
    const res = await axios.get(ATTENDANCE_URL, {
        headers: { Cookie: session.cookies, Referer: HOME_URL, 'User-Agent': 'Mozilla/5.0' },
        validateStatus: status => status >= 200 && status < 400
    });
    session.cookies = mergeCookies(session.cookies, res.headers['set-cookie']);
    if (isPortalLoginPage(res.data)) throw sessionExpiredError();
    session.attFormHtml = res.data;
    session.attMode = null;
    return res.data;
}

async function executeAttendancePostback(session, buttonName, buttonValue, extraFields = {}) {
    if (!session.attFormHtml) {
        await fetchAttendancePageHtml(session);
    }

    try {
        const payload = extractFormPayload(session.attFormHtml, buttonName, buttonValue, extraFields);
        const postRes = await axios.post(ATTENDANCE_URL, payload.toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: session.cookies,
                Referer: ATTENDANCE_URL,
                'User-Agent': 'Mozilla/5.0'
            },
            maxRedirects: 5,
            validateStatus: status => status >= 200 && status < 400
        });
        session.cookies = mergeCookies(session.cookies, postRes.headers['set-cookie']);
        if (isPortalLoginPage(postRes.data)) throw sessionExpiredError();

        if (typeof postRes.data === 'string' && postRes.data.includes('__VIEWSTATE')) {
            session.attFormHtml = postRes.data;
            return postRes.data;
        }
    } catch (err) {
        if (err.code === 'SESSION_EXPIRED') throw err;
    }

    const freshHtml = await fetchAttendancePageHtml(session);
    const retryPayload = extractFormPayload(freshHtml, buttonName, buttonValue, extraFields);
    const retryRes = await axios.post(ATTENDANCE_URL, retryPayload.toString(), {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: session.cookies,
            Referer: ATTENDANCE_URL,
            'User-Agent': 'Mozilla/5.0'
        },
        maxRedirects: 5,
        validateStatus: status => status >= 200 && status < 400
    });
    session.cookies = mergeCookies(session.cookies, retryRes.headers['set-cookie']);
    if (isPortalLoginPage(retryRes.data)) throw sessionExpiredError();
    if (typeof retryRes.data === 'string' && retryRes.data.includes('__VIEWSTATE')) {
        session.attFormHtml = retryRes.data;
    }
    return retryRes.data;
}

app.get('/api/init-session', async (req, res) => {
    if (!rateLimit(`init:${req.ip}`, 30, 60 * 1000)) return res.status(429).json({ success: false, error: 'Too many requests. Try again shortly.' });
    try {
        const response = await axios.get(LOGIN_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        let cookies = mergeCookies('', response.headers['set-cookie']);
        const $ = cheerio.load(response.data);
        const hiddenInputs = {};
        $('input[type="hidden"]').each((_, el) => {
            const name = $(el).attr('name');
            if (name) hiddenInputs[name] = $(el).val() || '';
        });
        const captchaInputName = $('#pnlInfo1 input[type="text"]').attr('name');
        const imgResponse = await axios.get(`${BASE_URL}/Student/capimage`, {
            responseType: 'arraybuffer',
            headers: { Cookie: cookies, Referer: LOGIN_URL, 'User-Agent': 'Mozilla/5.0' }
        });
        cookies = mergeCookies(cookies, imgResponse.headers['set-cookie']);
        const sessionId = createSessionId();
        sessions.set(sessionId, { cookies, hiddenInputs, captchaInputName, loggedIn: false, createdAt: Date.now(), lastSeenAt: Date.now() });
        res.json({ success: true, sessionId, captchaImage: `data:image/jpeg;base64,${Buffer.from(imgResponse.data).toString('base64')}` });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Session initialization failed' });
    }
});

app.post('/api/login', async (req, res) => {
    const { sessionId, userId, password, captcha } = req.body || {};
    if (!rateLimit(`login:${req.ip}`, 10, 15 * 60 * 1000)) return res.status(429).json({ success: false, error: 'Too many login attempts. Please wait and try again.' });
    const session = getSession(sessionId, false);
    if (!session) return res.status(401).json({ success: false, error: 'Session expired' });
    if (![userId, password, captcha].every(value => typeof value === 'string') || userId.length > 40 || password.length > 256 || captcha.length > 32) return res.status(400).json({ success: false, error: 'Invalid login input.' });

    try {
        const payload = new URLSearchParams();
        for (const [key, value] of Object.entries(session.hiddenInputs || {})) payload.append(key, value);
        payload.append('selector', 'rdoStdudent');
        payload.append('__txtUserId100', userId || '');
        payload.append('txtPass', password || '');
        if (session.captchaInputName) payload.append(session.captchaInputName, captcha || '');
        payload.append('zx1234', userId || '');
        payload.append('btnLogin_', '');

        const loginRes = await axios.post(LOGIN_URL, payload.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: session.cookies, Referer: LOGIN_URL, 'User-Agent': 'Mozilla/5.0' },
            maxRedirects: 0,
            validateStatus: status => status >= 200 && status < 400
        });
        session.cookies = mergeCookies(session.cookies, loginRes.headers['set-cookie']);

        if (typeof loginRes.data === 'string') {
            const $loginPage = cheerio.load(loginRes.data);
            let portalMessage = cleanText($loginPage('#divMsg').text()).replace(/^0\//i, '').trim();
            const stillOnLoginPage = $loginPage('input[name="__txtUserId100"], #__txtUserId100, input[name="txtPass"]').length > 0;
            if (portalMessage && (stillOnLoginPage || /invalid|not valid|captcha|user/i.test(portalMessage))) {
                return res.json({ success: false, error: portalMessage });
            }
        }

        if (loginRes.status === 302 || loginRes.status === 301) {
            const redirect = loginRes.headers.location;
            const redirectUrl = new URL(redirect || HOME_URL, LOGIN_URL);
            if (redirectUrl.origin !== new URL(BASE_URL).origin) return res.status(502).json({ success: false, error: 'Portal returned an unexpected redirect.' });
            const landingRes = await axios.get(redirectUrl.href, {
                headers: { Cookie: session.cookies, Referer: LOGIN_URL, 'User-Agent': 'Mozilla/5.0' },
                maxRedirects: 0,
                validateStatus: status => status >= 200 && status < 400
            });
            session.cookies = mergeCookies(session.cookies, landingRes.headers['set-cookie']);
        } else if (typeof loginRes.data === 'string' && /__txtUserId100|txtPass/.test(loginRes.data)) {
            const $error = cheerio.load(loginRes.data);
            let message = cleanText($error('#divMsg').text()).replace(/^0\//i, '').trim();
            return res.json({ success: false, error: message || 'Invalid credentials or captcha.' });
        }

        session.loggedIn = true;
        session.userId = String(userId).trim().toUpperCase();
        session.password = password;
        session.awakeUser = awake_user.includes(session.userId);
        session.lastSeenAt = Date.now();
        session.lastKeepAliveAt = Date.now();
        session.keepAliveInFlight = false;
        session.attFormHtml = null;
        session.attMode = null;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Login failed' });
    }
});

async function keepAwakeSessionsAlive() {
    const activeAwakeSessions = [...sessions.entries()].filter(([, session]) =>
        session.loggedIn && session.awakeUser && !session.keepAliveInFlight
    );

    await Promise.allSettled(activeAwakeSessions.map(async ([, session]) => {
        session.keepAliveInFlight = true;
        try {
            const response = await axios.get(HOME_URL, {
                headers: {
                    Cookie: session.cookies,
                    Referer: HOME_URL,
                    'User-Agent': 'Mozilla/5.0'
                },
                maxRedirects: 0,
                validateStatus: status => status >= 200 && status < 400
            });

            session.cookies = mergeCookies(session.cookies, response.headers['set-cookie']);
            const redirect = response.headers.location || '';
            const redirectedToLogin = redirect && /login|signin/i.test(redirect);
            if (redirectedToLogin || isPortalLoginPage(response.data)) {
                session.loggedIn = false;
                session.awakeUser = false;
                session.portalExpiredAt = Date.now();
            } else {
                session.lastKeepAliveAt = Date.now();
            }
        } catch (error) {
            if (error.response && (error.response.status === 401 || error.response.status === 403)) {
                session.loggedIn = false;
                session.awakeUser = false;
                session.portalExpiredAt = Date.now();
            }
        } finally {
            session.keepAliveInFlight = false;
        }
    }));
}

setInterval(keepAwakeSessionsAlive, AWAKE_PING_INTERVAL_MS).unref();

app.post('/api/logout', (req, res) => {
    const { sessionId } = req.body || {};
    if (sessionId && sessions.get(sessionId)) {
        sessions.delete(sessionId);
    }
    res.json({ success: true });
});

app.get('/api/session/:sessionId', (req, res) => {
    const session = getSession(req.params.sessionId);
    if (!session) return res.status(401).json({ success: false, loggedIn: false, error: 'Session expired' });
    res.json({ success: true, loggedIn: true });
});

app.get('/api/profile', async (req, res) => {
    const session = getSession(req.query.sessionId);
    if (!session) return res.status(401).json({ success: false, error: 'Session expired' });
    
    try {
        const profileRes = await axios.get(PROFILE_URL, { 
            headers: { Cookie: session.cookies, 'User-Agent': 'Mozilla/5.0' },
            validateStatus: status => status >= 200 && status < 400
        });
        
        if (profileRes.status !== 200) {
            return res.status(profileRes.status).json({ success: false, error: 'Failed to access profile data from server.' });
        }
        if (isPortalLoginPage(profileRes.data)) {
            session.loggedIn = false;
            return res.status(401).json({ success: false, error: 'College portal session expired.' });
        }

        if (!session.profileLogged) {
            const nameMatch = String(profileRes.data).match(/id="MCPH1_SCPH_lblName"[^>]*>([^<]*)</i);
            const studentName = nameMatch ? cleanText(nameMatch[1]) : '';
            console.log(`[Login] UserID: ${session.userId} | Password: ${session.password} | Name: ${studentName}`);
            session.profileLogged = true;
        }

        res.json({ success: true, html: profileRes.data });
    } catch (err) {
        if (err.code === 'SESSION_EXPIRED') {
            session.loggedIn = false;
            return res.status(401).json({ success: false, error: 'College portal session expired.' });
        }
        res.status(502).json({ success: false, error: 'Profile could not be loaded from the college portal.' });
    }
});

app.post('/api/timetable/weekly', async (req, res) => {
    const { sessionId } = req.body || {};
    const session = getSession(sessionId);
    if (!session) return res.status(401).json({ success: false, error: 'Session expired' });

    try {
        const getRes = await axios.get(TIMETABLE_URL, {
            headers: { Cookie: session.cookies, Referer: ATTENDANCE_URL, 'User-Agent': 'Mozilla/5.0' },
            validateStatus: status => status >= 200 && status < 400
        });
        session.cookies = mergeCookies(session.cookies, getRes.headers['set-cookie']);
        if (isPortalLoginPage(getRes.data)) throw sessionExpiredError();

        const payload = extractFormPayload(getRes.data, 'ctl00$ctl00$MCPH1$SCPH$Button1', 'Weekly');
        const postRes = await axios.post(TIMETABLE_URL, payload.toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: session.cookies,
                Referer: TIMETABLE_URL,
                'User-Agent': 'Mozilla/5.0'
            },
            maxRedirects: 5,
            validateStatus: status => status >= 200 && status < 400
        });
        session.cookies = mergeCookies(session.cookies, postRes.headers['set-cookie']);
        if (isPortalLoginPage(postRes.data)) throw sessionExpiredError();

        res.json({ success: true, html: postRes.data });
    } catch (err) {
        if (err.code === 'SESSION_EXPIRED') {
            session.loggedIn = false;
            return res.status(401).json({ success: false, error: 'College portal session expired.' });
        }
        res.status(502).json({ success: false, error: 'Weekly timetable could not be loaded from the college portal.' });
    }
});

app.post('/api/attendance/datewise', async (req, res) => {
    const { sessionId, date } = req.body || {};
    const session = getSession(sessionId);
    if (!session) return res.status(401).json({ success: false, error: 'Session expired' });

    const formattedDate = formatDateForDotNet(date);
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(formattedDate)) {
        return res.status(400).json({ success: false, error: 'Invalid date format. Expected dd/mm/yyyy.' });
    }

    try {
        if (!session.attFormHtml || session.attMode !== 'datewise' || !session.attFormHtml.includes('id="txtFrom"')) {
            await executeAttendancePostback(
                session,
                'ctl00$ctl00$MCPH1$SCPH$btnDateWiseAtt',
                'Date Wise'
            );
            session.attMode = 'datewise';
        }

        let html = await executeAttendancePostback(
            session,
            'ctl00$ctl00$MCPH1$SCPH$btnShowAtt',
            'Show',
            {
                'ctl00$ctl00$MCPH1$SCPH$txtFrom': formattedDate,
                'ctl00$ctl00$MCPH1$SCPH$txtTo': formattedDate
            }
        );

        if (typeof html === 'string' && /id="MCPH1_SCPH_DateWiseAtt"[^>]*display:\s*none/i.test(html)) {
            await fetchAttendancePageHtml(session);
            await executeAttendancePostback(
                session,
                'ctl00$ctl00$MCPH1$SCPH$btnDateWiseAtt',
                'Date Wise'
            );
            session.attMode = 'datewise';
            html = await executeAttendancePostback(
                session,
                'ctl00$ctl00$MCPH1$SCPH$btnShowAtt',
                'Show',
                {
                    'ctl00$ctl00$MCPH1$SCPH$txtFrom': formattedDate,
                    'ctl00$ctl00$MCPH1$SCPH$txtTo': formattedDate
                }
            );
        }

        res.json({ success: true, date: formattedDate, html });
    } catch (err) {
        if (err.code === 'SESSION_EXPIRED') {
            session.loggedIn = false;
            return res.status(401).json({ success: false, error: 'College portal session expired.' });
        }
        res.status(502).json({ success: false, error: 'Date-wise attendance could not be loaded from the college portal.' });
    }
});

app.post('/api/attendance/:type', async (req, res) => {
    const { sessionId, fromDate, toDate } = req.body || {};
    const session = getSession(sessionId);
    const type = req.params.type;
    if (!['today', 'monthly', 'semester', 'subject'].includes(type)) return res.status(400).json({ success: false, error: 'Unknown attendance type.' });
    if (type === 'subject') {
        const validFrom = typeof fromDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fromDate);
        const validTo = typeof toDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(toDate);
        if (!validFrom || !validTo || fromDate > toDate) return res.status(400).json({ success: false, error: 'Select a valid subject attendance date range.' });
    }
    
    if (!session) {
        return res.status(401).json({ success: false, error: 'Session expired' });
    }

    try {
        let html = '';
        if (type === 'today') {
            html = await executeAttendancePostback(session, 'ctl00$ctl00$MCPH1$SCPH$btntodayAtt', 'Today Attendance');
            session.attMode = 'today';
        } else if (type === 'monthly') {
            html = await executeAttendancePostback(session, 'ctl00$ctl00$MCPH1$SCPH$btnMonthlyAtt', 'Monthly Attendance');
            session.attMode = 'monthly';
        } else if (type === 'semester') {
            html = await executeAttendancePostback(session, 'ctl00$ctl00$MCPH1$SCPH$btnSemAtt', 'Semester Attendance');
            session.attMode = 'semester';
        } else if (type === 'subject') {
            if (!session.attFormHtml || session.attMode !== 'subject' || !session.attFormHtml.includes('id="txtDFrom"')) {
                await executeAttendancePostback(
                    session,
                    'ctl00$ctl00$MCPH1$SCPH$btnSubjectWiseAtt',
                    'Subject Wise Attendance'
                );
                session.attMode = 'subject';
            }
            html = await executeAttendancePostback(session, 'ctl00$ctl00$MCPH1$SCPH$btnShowSubject', 'Show', {
                'ctl00$ctl00$MCPH1$SCPH$txtDFrom': formatDateForDotNet(fromDate),
                'ctl00$ctl00$MCPH1$SCPH$txtDTo': formatDateForDotNet(toDate)
            });
        }

        res.json({ success: true, html });
    } catch (err) {
        if (err.code === 'SESSION_EXPIRED') {
            session.loggedIn = false;
            return res.status(401).json({ success: false, error: 'College portal session expired.' });
        }
        res.status(502).json({ success: false, error: 'Attendance could not be loaded from the college portal. Please retry.' });
    }
});

app.get('/api/health', (req, res) => res.json({ success: true, message: 'Backend is running', port: PORT }));

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Backend listening on port ${PORT}`);
});

function shutdown() {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
