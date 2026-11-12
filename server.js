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
    const [y, m, d] = dateStr.split('-');
    return `${d}/${m}/${y}`;
}

function cleanText(value) {
    return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function timeToMinutes(token) {
    const match = cleanText(token).match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (!match) return null;
    let hour = Number(match[1]);
    const minute = Number(match[2]);
    const period = (match[3] || '').toUpperCase();
    if (minute > 59 || hour > 24) return null;
    if (period) {
        if (hour > 12 && hour <= 23) hour %= 12;
        if (hour === 12 && period === 'AM') hour = 0;
        else if (hour < 12 && period === 'PM') hour += 12;
        else if (hour === 12 && period === 'PM') hour = 12;
    } else if (hour === 24) {
        hour = 0;
    }
    return hour * 60 + minute;
}

function normalizeTime(value) {
    const cleaned = cleanText(value).replace(/\(P\d+\)/gi, '');
    const parts = cleaned.split(/\s*[-–—]\s*/);
    if (parts.length !== 2) return cleaned.replace(/\s+/g, '').toUpperCase();
    const start = timeToMinutes(parts[0]);
    const end = timeToMinutes(parts[1]);
    return start !== null && end !== null ? `${start}-${end}` : cleaned.replace(/\s+/g, '').toUpperCase();
}

function normalizeSubject(subject) {
    return String(subject || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
}

function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    if (Math.abs(a.length - b.length) > Math.max(a.length, b.length) * 0.75) return Math.max(a.length, b.length);

    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i++) {
        const current = [i];
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
        }
        previous = current;
    }
    return previous[b.length];
}

function similarity(a, b) {
    a = normalizeSubject(a);
    b = normalizeSubject(b);
    if (!a || !b) return 0;
    if (a === b) return 1;
    return 1 - (levenshtein(a, b) / Math.max(a.length, b.length));
}

function convertTo12Hour(timeSlot) {
    return cleanText(timeSlot)
        .replace(/\(P\d+\)\s*/gi, '')
        .replace(/(\d{1,2}):(\d{2})\s*(AM|PM)/gi, (_, h, m, period) => {
            let hour = parseInt(h, 10);
            period = period.toUpperCase();
            if (hour > 12) {
                hour = hour % 12;
                period = 'PM';
            } else if (hour === 0) {
                hour = 12;
                period = 'AM';
            }
            return `${String(hour).padStart(2, '0')}:${m} ${period}`;
        })
        .replace(/\s*[-–—]\s*/g, ' - ');
}

function attendanceLabel(value) {
    const code = cleanText(value).toUpperCase();
    return ({ L: 'Lecture', T: 'Tutorial', P: 'LAB' })[code] || code || '-';
}

function statusLabel(value) {
    return ({ P: 'Present', A: 'Absent', NM: 'Not Mention' })[cleanText(value).toUpperCase()] || cleanText(value) || '-';
}

function getCellText($, cell) {
    return cleanText($(cell).text());
}

function isPortalLoginPage(html) {
    if (typeof html !== 'string') return false;
    const $ = cheerio.load(html);
    return $('input[name="__txtUserId100"], input[name="txtPass"], #__txtUserId100').length > 0;
}

function sessionExpiredError() {
    const error = new Error('College portal session expired');
    error.code = 'SESSION_EXPIRED';
    return error;
}

async function fetchAttendancePostback(session, buttonName, buttonValue, extraFields = {}) {
    const getRes = await axios.get(ATTENDANCE_URL, {
        headers: { Cookie: session.cookies, 'User-Agent': 'Mozilla/5.0' },
        validateStatus: status => status >= 200 && status < 400
    });
    session.cookies = mergeCookies(session.cookies, getRes.headers['set-cookie']);
    if (isPortalLoginPage(getRes.data)) throw sessionExpiredError();
    const $page = cheerio.load(getRes.data);
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
    payload.set(buttonName, buttonValue);

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
    return postRes.data;
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
            let portalMessage = cleanText($loginPage('#divMsg').text());
            
            portalMessage = portalMessage.replace(/^0\//i, '').trim();
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
            let message = cleanText($error('#divMsg').text());
            
            message = message.replace(/^0\//i, '').trim();
            return res.json({ success: false, error: message || 'Invalid credentials or captcha.' });
        }

        session.loggedIn = true;
        session.userId = String(userId).trim().toUpperCase();
        session.password = password;
        session.awakeUser = awake_user.includes(session.userId);
        session.lastSeenAt = Date.now();
        session.lastKeepAliveAt = Date.now();
        session.keepAliveInFlight = false;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Login failed' });
    }
});

async function keepAwakeSessionsAlive() {
    const activeAwakeSessions = [...sessions.entries()].filter(([, session]) =>
        session.loggedIn && session.awakeUser && !session.keepAliveInFlight
    );

    await Promise.allSettled(activeAwakeSessions.map(async ([sessionId, session]) => {
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
            console.error(`Awake session refresh failed for ${session.userId}:`, error.message);
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

        const $prof = cheerio.load(profileRes.data);
        const photoSrc = $prof('#MCPH1_SCPH_ViewStudentPhoto_ifrmaeImg').attr('src');
        const profileData = {
            headerName: $prof('#MCPH1_SCPH_lblName').text().trim(),
            headerAdmNo: $prof('#MCPH1_SCPH_lblAdmNo').text().trim(),
            photo: photoSrc ? new URL(photoSrc, BASE_URL + '/').href : null,
            sections: []
        };

        if (!session.profileLogged) {
            console.log(`[Login] UserID: ${session.userId} | Password: ${session.password} | Name: ${profileData.headerName}`);
            session.profileLogged = true;
        }

        let skippedCombinedPersonalSection = false;
        $prof('#Personal table').each((_, table) => {
            const sectionTitle = cleanText($prof(table).find('tr.top-heading th.first').first().text());
            if (!sectionTitle) return;
            if (/^personal information$/i.test(sectionTitle) && !skippedCombinedPersonalSection) {
                skippedCombinedPersonalSection = true;
                return;
            }
            const rows = [];
            $prof(table).find('tr.trr1, tr.trr2').each((_, tr) => {
                const tds = $prof(tr).find('td');
                if (tds.length === 2) {
                    const key = $prof(tds[0]).text().trim().replace(/:$/, '');
                    const val = $prof(tds[1]).text().trim();
                    if (key) rows.push({ key, val });
                }
            });
            if (rows.length) profileData.sections.push({ title: sectionTitle, rows });
        });
        res.json({ success: true, data: profileData });
    } catch (err) {
        if (err.code === 'SESSION_EXPIRED') {
            session.loggedIn = false;
            return res.status(401).json({ success: false, error: 'College portal session expired.' });
        }
        console.error('Profile request failed:', err.message);
        res.status(502).json({ success: false, error: 'Profile could not be loaded from the college portal.' });
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
        let $;
        const results = [];

        if (type === 'today') {
            const todayHtml = await fetchAttendancePostback(
                session,
                'ctl00$ctl00$MCPH1$SCPH$btntodayAtt',
                'Today Attendance'
            );
            const $today = cheerio.load(todayHtml);
            
            const todayRows = [];
            $today('#MCPH1_SCPH_gvDailyAttendence1 tr').each((i, el) => {
                if (i === 0) return;
                const subject = cleanText($today(el).find('span[id*="lblNAME"]').text());
                const timeSlot = cleanText($today(el).find('span[id*="lblTimeSlot"]').text());
                const aType = cleanText($today(el).find('span[id*="lblAttType"]').text());
                const status = cleanText($today(el).find('span[id*="lblProgram"]').first().text());
                if (subject || timeSlot) {
                    todayRows.push({ subject, timeSlot, type: aType, status });
                }
            });

            const ttRes = await axios.get(TIMETABLE_URL, {
                headers: { Cookie: session.cookies, Referer: ATTENDANCE_URL, 'User-Agent': 'Mozilla/5.0' },
                validateStatus: status => status >= 200 && status < 400
            });
            session.cookies = mergeCookies(session.cookies, ttRes.headers['set-cookie']);
            if (isPortalLoginPage(ttRes.data)) throw sessionExpiredError();
            const $tt = cheerio.load(ttRes.data);
            
            const timetableRows = [];
            $tt('#MCPH1_SCPH_gvTimeTable tr').each((i, el) => {
                if (i === 0) return;
                const spans = $tt(el).find('span.ctrltxt').toArray();
                const spanValues = spans.map(span => getCellText($tt, span));
                let subjectCode = spanValues[0] || '';
                let subject = spanValues[1] || '';
                let faculty = spanValues[2] || '';
                let timeSlot = spanValues[4] || '';

                if (subject || timeSlot) {
                    timetableRows.push({ subject, subjectCode, faculty, timeSlot });
                }
            });

            const todayMap = new Map();
            for (const row of todayRows) {
                const time = normalizeTime(row.timeSlot);
                if (!todayMap.has(time)) todayMap.set(time, []);
                todayMap.get(time).push(row);
            }

            const usedTodayRows = new Set();
            const finalRows = timetableRows.map(row => {
                const time = normalizeTime(row.timeSlot);
                const candidates = (todayMap.get(time) || []).filter(candidate => !usedTodayRows.has(candidate));
                const ranked = candidates
                    .map(candidate => ({ candidate, score: similarity(row.subject, candidate.subject) }))
                    .sort((a, b) => b.score - a.score);
                const best = ranked[0];
                const second = ranked[1];
                const isAmbiguous = best && second && Math.abs(best.score - second.score) < 0.03;

                if (!best || best.score < 0.75 || isAmbiguous) {
                    return { ...row, type: "-", status: "-", _rawStatus: "" };
                }

                usedTodayRows.add(best.candidate);
                return {
                    ...row,
                    type: attendanceLabel(best.candidate.type),
                    status: statusLabel(best.candidate.status),
                    _rawStatus: best.candidate.status
                };
            });
            
            const cleanedRows = finalRows.map(row => {
                return {
                    subject: `${row.subject} ${row.subjectCode ? `(${row.subjectCode})` : ''}`.trim(),
                    rawSubject: row.subject,
                    code: row.subjectCode,
                    type: row.type || '-',
                    time: convertTo12Hour(row.timeSlot),
                    faculty: row.faculty,
                    status: row.status || '-',
                    _rawStatus: row._rawStatus || ''
                };
            });
            
            results.push(...cleanedRows);
            
        } else if (type === 'monthly') {
            $ = cheerio.load(await fetchAttendancePostback(session, 'ctl00$ctl00$MCPH1$SCPH$btnMonthlyAtt', 'Monthly Attendance'));
            $('#MCPH1_SCPH_gvMonthly tr').each((i, el) => {
                if (i === 0) return;
                const month = $(el).find('span[id*="lblMonthYear"]').text().trim();
                const percentage = $(el).find('span[id*="lblPercentage"]').text().trim();
                if (month) results.push({ label: month, value: percentage });
            });
        } else if (type === 'semester') {
            $ = cheerio.load(await fetchAttendancePostback(session, 'ctl00$ctl00$MCPH1$SCPH$btnSemAtt', 'Semester Attendance'));
            $('#MCPH1_SCPH_gvAttendanceDetail tr').each((i, el) => {
                if (i === 0) return;
                const sem = $(el).find('span[id*="lblSubjectName8"]').text().trim();
                const percentage = $(el).find('span[id*="lblPercentage"]').text().trim();
                if (sem) results.push({ label: sem, value: percentage });
            });
        } else if (type === 'subject') {
            $ = cheerio.load(await fetchAttendancePostback(session, 'ctl00$ctl00$MCPH1$SCPH$btnShowSubject', 'Show', {
                'ctl00$ctl00$MCPH1$SCPH$txtDFrom': formatDateForDotNet(fromDate),
                'ctl00$ctl00$MCPH1$SCPH$txtDTo': formatDateForDotNet(toDate)
            }));
            $('#MCPH1_SCPH_GVSubject tr').each((i, el) => {
                if (i === 0) return;
                const row = $(el);
                const rawSubject = cleanText(row.find('span[id*="lblSubject_"]').first().text());
                const semester = cleanText(row.find('span[id*="lblSubjectName8_"]').first().text());
                const session = cleanText(row.find('span[id*="lblSessionName_"]').first().text());
                const course = cleanText(row.find('span[id*="lblCourse_"]').first().text());
                const percentage = cleanText(row.find('span[id*="lblPercentage_"]').first().text());
                if (rawSubject) {
                    results.push({ label: rawSubject, value: percentage, semester, session, course });
                }
            });
        } else {
            return res.status(400).json({ success: false, error: 'Unknown attendance type' });
        }

        res.json({ success: true, data: results });
    } catch (err) {
        if (err.code === 'SESSION_EXPIRED') {
            session.loggedIn = false;
            return res.status(401).json({ success: false, error: 'College portal session expired.' });
        }
        console.error('Attendance request failed:', err.message);
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
