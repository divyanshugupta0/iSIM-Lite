// Cloudflare Worker for iSIM-Lite
// Blazing fast edge proxy for GL Bajaj Student Portal

const BASE_URL = 'https://glb.servergi.com:8071/iSIMGLBMTR';
const LOGIN_URL = `${BASE_URL}/Login`;
const HOME_URL = `${BASE_URL}/home`;
const PROFILE_URL = `${BASE_URL}/Student/Course`;
const ATTENDANCE_URL = `${BASE_URL}/Student/TodayAttendence`;
const TIMETABLE_URL = `${BASE_URL}/Student/TimeTable`;

const VAPID_PUBLIC_KEY = 'BOrP0npFRyqTzIa6E9PdNEJyn4YTT2dWarME4AT61Qv1Rvb7Z7H0QmKBlzTpcydwHI4OLqGxztBSGela9lnT6gM';
const VAPID_PRIVATE_KEY = '40k1y1KeUs4AqMmbVL9SeFeIbhS8jl_tVl5tjm_GfCM';

// In-memory sessions cache for warm worker instances
const memorySessions = new Map();
const pushSubscriptions = new Map();

function cleanText(value) {
    return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function formatDateForDotNet(dateStr) {
    if (!dateStr) return '';
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) return dateStr;
    const [y, m, d] = dateStr.split('-');
    return `${d}/${m}/${y}`;
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

function getCookieHeaders(headers) {
    if (typeof headers.getSetCookie === 'function') {
        return headers.getSetCookie();
    }
    const raw = headers.get('set-cookie');
    return raw ? [raw] : [];
}

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

function extractFormPayload(html, buttonName, buttonValue, extraFields = {}) {
    const payload = new URLSearchParams();
    
    // Extract <input> elements
    const inputMatches = html.matchAll(/<input[^>]+>/gi);
    for (const match of inputMatches) {
        const tag = match[0];
        const nameMatch = tag.match(/name=["']([^"']+)["']/i);
        if (!nameMatch) continue;
        const name = nameMatch[1];
        
        const typeMatch = tag.match(/type=["']([^"']+)["']/i);
        const type = typeMatch ? typeMatch[1].toLowerCase() : 'text';
        if (['submit', 'button', 'image', 'reset', 'file'].includes(type)) continue;
        if ((type === 'checkbox' || type === 'radio') && !/\bchecked\b/i.test(tag)) continue;
        
        const valMatch = tag.match(/value=["']([^"']*)["']/i);
        const val = valMatch ? valMatch[1] : '';
        payload.append(name, val);
    }

    // Extract <select> elements
    const selectMatches = html.matchAll(/<select[^>]*name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/select>/gi);
    for (const match of selectMatches) {
        const name = match[1];
        const optionsHtml = match[2];
        const selectedMatch = optionsHtml.match(/<option[^>]+selected[^>]*value=["']([^"']*)["']/i) ||
                              optionsHtml.match(/<option[^>]*value=["']([^"']*)["']/i);
        if (selectedMatch) {
            payload.append(name, selectedMatch[1]);
        }
    }

    // Add extra fields and button trigger
    for (const [key, value] of Object.entries(extraFields)) {
        payload.set(key, value);
    }
    if (buttonName) {
        payload.set(buttonName, buttonValue);
    }
    return payload;
}

// Session Management (KV + Memory Fallback)
async function getSession(sessionId, env, requireLogin = true) {
    if (!sessionId) return null;
    let session = memorySessions.get(sessionId);
    
    const kv = env.KV || env.SESSIONS;
    if (!session && kv) {
        try {
            const raw = await kv.get(sessionId);
            if (raw) session = JSON.parse(raw);
        } catch (_) {}
    }

    if (!session) return null;
    if (requireLogin && !session.loggedIn) return null;
    return session;
}

async function saveSession(sessionId, session, env) {
    memorySessions.set(sessionId, session);
    const kv = env.KV || env.SESSIONS;
    if (kv) {
        try {
            await kv.put(sessionId, JSON.stringify(session), { expirationTtl: 3600 * 12 });
        } catch (_) {}
    }
}

async function fetchAttendancePageHtml(session) {
    const res = await fetch(ATTENDANCE_URL, {
        headers: { Cookie: session.cookies, Referer: HOME_URL, 'User-Agent': 'Mozilla/5.0' },
    });
    session.cookies = mergeCookies(session.cookies, getCookieHeaders(res.headers));
    const data = await res.text();
    if (isPortalLoginPage(data)) throw sessionExpiredError();
    session.attFormHtml = data;
    session.attMode = null;
    return data;
}

async function executeAttendancePostback(session, buttonName, buttonValue, extraFields = {}) {
    if (!session.attFormHtml) {
        await fetchAttendancePageHtml(session);
    }

    try {
        const payload = extractFormPayload(session.attFormHtml, buttonName, buttonValue, extraFields);
        const postRes = await fetch(ATTENDANCE_URL, {
            method: 'POST',
            body: payload.toString(),
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: session.cookies,
                Referer: ATTENDANCE_URL,
                'User-Agent': 'Mozilla/5.0'
            },
            redirect: 'manual'
        });
        session.cookies = mergeCookies(session.cookies, getCookieHeaders(postRes.headers));
        const postData = await postRes.text();
        if (isPortalLoginPage(postData)) throw sessionExpiredError();

        if (typeof postData === 'string' && postData.includes('__VIEWSTATE')) {
            session.attFormHtml = postData;
            return postData;
        }
    } catch (err) {
        if (err.code === 'SESSION_EXPIRED') throw err;
    }

    const freshHtml = await fetchAttendancePageHtml(session);
    const retryPayload = extractFormPayload(freshHtml, buttonName, buttonValue, extraFields);
    const retryRes = await fetch(ATTENDANCE_URL, {
        method: 'POST',
        body: retryPayload.toString(),
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: session.cookies,
            Referer: ATTENDANCE_URL,
            'User-Agent': 'Mozilla/5.0'
        },
        redirect: 'manual'
    });
    session.cookies = mergeCookies(session.cookies, getCookieHeaders(retryRes.headers));
    const retryData = await retryRes.text();
    if (isPortalLoginPage(retryData)) throw sessionExpiredError();
    if (typeof retryData === 'string' && retryData.includes('__VIEWSTATE')) {
        session.attFormHtml = retryData;
    }
    return retryData;
}

// CORS helper
function makeCorsResponse(data, status = 200) {
    return new Response(typeof data === 'string' ? data : JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        }
    });
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // Handle CORS Preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                    'Access-Control-Max-Age': '86400',
                }
            });
        }

        // --- API ROUTES ---

        // 1. GET /api/init-session
        if (url.pathname === '/api/init-session' && request.method === 'GET') {
            try {
                const response = await fetch(LOGIN_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                let cookies = mergeCookies('', getCookieHeaders(response.headers));
                const html = await response.text();

                // Hidden ASP.NET inputs
                const hiddenInputs = {};
                const matches = html.matchAll(/name="(__[^"]+)"[^>]*value="([^"]*)"/g);
                for (const m of matches) hiddenInputs[m[1]] = m[2];

                // Captcha input name
                const capInputMatch = html.match(/id="pnlInfo1"[^>]*>[\s\S]*?<input[^>]*type="text"[^>]*name="([^"]+)"/i);
                const captchaInputName = capInputMatch ? capInputMatch[1] : null;

                // Download captcha image
                const imgResponse = await fetch(`${BASE_URL}/Student/capimage`, {
                    headers: { Cookie: cookies, Referer: LOGIN_URL, 'User-Agent': 'Mozilla/5.0' }
                });
                cookies = mergeCookies(cookies, getCookieHeaders(imgResponse.headers));
                const arrayBuffer = await imgResponse.arrayBuffer();
                const base64Img = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));

                const sessionId = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
                const sessionObj = { cookies, hiddenInputs, captchaInputName, loggedIn: false, createdAt: Date.now() };
                await saveSession(sessionId, sessionObj, env);

                return makeCorsResponse({
                    success: true,
                    sessionId,
                    captchaImage: `data:image/jpeg;base64,${base64Img}`
                });
            } catch (err) {
                return makeCorsResponse({ success: false, error: 'Session initialization failed: ' + err.message }, 500);
            }
        }

        // 2. POST /api/login
        if (url.pathname === '/api/login' && request.method === 'POST') {
            try {
                const body = await request.json();
                const { sessionId, userId, password, captcha } = body || {};
                const session = await getSession(sessionId, env, false);
                if (!session) return makeCorsResponse({ success: false, error: 'Session expired' }, 401);

                const payload = new URLSearchParams();
                for (const [key, value] of Object.entries(session.hiddenInputs || {})) {
                    payload.append(key, value);
                }
                payload.append('selector', 'rdoStdudent');
                payload.append('__txtUserId100', userId || '');
                payload.append('txtPass', password || '');
                if (session.captchaInputName) payload.append(session.captchaInputName, captcha || '');
                payload.append('zx1234', userId || '');
                payload.append('btnLogin_', '');

                const loginRes = await fetch(LOGIN_URL, {
                    method: 'POST',
                    body: payload.toString(),
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        Cookie: session.cookies,
                        Referer: LOGIN_URL,
                        'User-Agent': 'Mozilla/5.0'
                    },
                    redirect: 'manual'
                });

                session.cookies = mergeCookies(session.cookies, getCookieHeaders(loginRes.headers));
                const loginData = await loginRes.text();

                if (loginRes.status === 302 || loginRes.status === 301) {
                    const redirect = loginRes.headers.get('location') || HOME_URL;
                    const redirectUrl = new URL(redirect, LOGIN_URL);
                    const landingRes = await fetch(redirectUrl.href, {
                        headers: { Cookie: session.cookies, Referer: LOGIN_URL, 'User-Agent': 'Mozilla/5.0' },
                        redirect: 'manual'
                    });
                    session.cookies = mergeCookies(session.cookies, getCookieHeaders(landingRes.headers));
                } else if (isPortalLoginPage(loginData)) {
                    const msgMatch = loginData.match(/id="divMsg"[^>]*>([^<]*)</i);
                    const message = msgMatch ? cleanText(msgMatch[1]).replace(/^0\//i, '').trim() : 'Invalid credentials or captcha.';
                    return makeCorsResponse({ success: false, error: message });
                }

                session.loggedIn = true;
                session.userId = String(userId).trim().toUpperCase();
                session.password = password;
                session.lastSeenAt = Date.now();
                session.attFormHtml = null;
                session.attMode = null;
                await saveSession(sessionId, session, env);

                return makeCorsResponse({ success: true });
            } catch (err) {
                return makeCorsResponse({ success: false, error: 'Login failed: ' + err.message }, 500);
            }
        }

        // 3. GET /api/session/:sessionId
        if (url.pathname.startsWith('/api/session/') && request.method === 'GET') {
            const sid = url.pathname.split('/')[3];
            const session = await getSession(sid, env);
            if (!session) return makeCorsResponse({ success: false, loggedIn: false, error: 'Session expired' }, 401);
            return makeCorsResponse({ success: true, loggedIn: true });
        }

        // 4. POST /api/logout
        if (url.pathname === '/api/logout' && request.method === 'POST') {
            try {
                const { sessionId } = await request.json() || {};
                if (sessionId) {
                    memorySessions.delete(sessionId);
                    const kv = env.KV || env.SESSIONS;
                    if (kv) await kv.delete(sessionId);
                }
            } catch (_) {}
            return makeCorsResponse({ success: true });
        }

        // 5. GET /api/profile
        if (url.pathname === '/api/profile' && request.method === 'GET') {
            const sid = url.searchParams.get('sessionId');
            const session = await getSession(sid, env);
            if (!session) return makeCorsResponse({ success: false, error: 'Session expired' }, 401);

            try {
                const profileRes = await fetch(PROFILE_URL, {
                    headers: { Cookie: session.cookies, 'User-Agent': 'Mozilla/5.0' }
                });
                const data = await profileRes.text();
                session.cookies = mergeCookies(session.cookies, getCookieHeaders(profileRes.headers));
                if (isPortalLoginPage(data)) {
                    session.loggedIn = false;
                    await saveSession(sid, session, env);
                    return makeCorsResponse({ success: false, error: 'College portal session expired.' }, 401);
                }
                await saveSession(sid, session, env);
                return makeCorsResponse({ success: true, html: data });
            } catch (err) {
                return makeCorsResponse({ success: false, error: 'Profile could not be loaded.' }, 502);
            }
        }

        // 6. POST /api/timetable/weekly
        if (url.pathname === '/api/timetable/weekly' && request.method === 'POST') {
            try {
                const { sessionId } = await request.json() || {};
                const session = await getSession(sessionId, env);
                if (!session) return makeCorsResponse({ success: false, error: 'Session expired' }, 401);

                const getRes = await fetch(TIMETABLE_URL, {
                    headers: { Cookie: session.cookies, Referer: ATTENDANCE_URL, 'User-Agent': 'Mozilla/5.0' }
                });
                session.cookies = mergeCookies(session.cookies, getCookieHeaders(getRes.headers));
                const getData = await getRes.text();
                if (isPortalLoginPage(getData)) throw sessionExpiredError();

                const payload = extractFormPayload(getData, 'ctl00$ctl00$MCPH1$SCPH$Button1', 'Weekly');
                const postRes = await fetch(TIMETABLE_URL, {
                    method: 'POST',
                    body: payload.toString(),
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        Cookie: session.cookies,
                        Referer: TIMETABLE_URL,
                        'User-Agent': 'Mozilla/5.0'
                    }
                });
                session.cookies = mergeCookies(session.cookies, getCookieHeaders(postRes.headers));
                const postData = await postRes.text();
                await saveSession(sessionId, session, env);
                return makeCorsResponse({ success: true, html: postData });
            } catch (err) {
                return makeCorsResponse({ success: false, error: 'Timetable could not be loaded.' }, 502);
            }
        }

        // 7. POST /api/attendance/datewise
        if (url.pathname === '/api/attendance/datewise' && request.method === 'POST') {
            try {
                const { sessionId, date } = await request.json() || {};
                const session = await getSession(sessionId, env);
                if (!session) return makeCorsResponse({ success: false, error: 'Session expired' }, 401);

                const formattedDate = formatDateForDotNet(date);
                if (!/^\d{2}\/\d{2}\/\d{4}$/.test(formattedDate)) {
                    return makeCorsResponse({ success: false, error: 'Invalid date format. Expected dd/mm/yyyy.' }, 400);
                }

                if (!session.attFormHtml || session.attMode !== 'datewise' || !session.attFormHtml.includes('id="txtFrom"')) {
                    await executeAttendancePostback(session, 'ctl00$ctl00$MCPH1$SCPH$btnDateWiseAtt', 'Date Wise');
                    session.attMode = 'datewise';
                }

                let html = await executeAttendancePostback(session, 'ctl00$ctl00$MCPH1$SCPH$btnShowAtt', 'Show', {
                    'ctl00$ctl00$MCPH1$SCPH$txtFrom': formattedDate,
                    'ctl00$ctl00$MCPH1$SCPH$txtTo': formattedDate
                });

                await saveSession(sessionId, session, env);
                return makeCorsResponse({ success: true, date: formattedDate, html });
            } catch (err) {
                return makeCorsResponse({ success: false, error: 'Attendance could not be loaded.' }, 502);
            }
        }

        // 8. POST /api/attendance/:type
        if (url.pathname.startsWith('/api/attendance/') && request.method === 'POST') {
            const type = url.pathname.split('/')[3];
            try {
                const { sessionId, fromDate, toDate } = await request.json() || {};
                const session = await getSession(sessionId, env);
                if (!session) return makeCorsResponse({ success: false, error: 'Session expired' }, 401);

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
                        await executeAttendancePostback(session, 'ctl00$ctl00$MCPH1$SCPH$btnSubjectWiseAtt', 'Subject Wise Attendance');
                        session.attMode = 'subject';
                    }
                    html = await executeAttendancePostback(session, 'ctl00$ctl00$MCPH1$SCPH$btnShowSubject', 'Show', {
                        'ctl00$ctl00$MCPH1$SCPH$txtDFrom': formatDateForDotNet(fromDate),
                        'ctl00$ctl00$MCPH1$SCPH$txtDTo': formatDateForDotNet(toDate)
                    });
                } else {
                    return makeCorsResponse({ success: false, error: 'Unknown attendance type.' }, 400);
                }

                await saveSession(sessionId, session, env);
                return makeCorsResponse({ success: true, html });
            } catch (err) {
                return makeCorsResponse({ success: false, error: 'Attendance could not be loaded.' }, 502);
            }
        }

        // 9. Push Notification Endpoints
        if (url.pathname === '/api/push/vapid-public-key') {
            return makeCorsResponse({ success: true, publicKey: VAPID_PUBLIC_KEY });
        }
        if (url.pathname === '/api/push/subscribe' && request.method === 'POST') {
            const body = await request.json() || {};
            if (body.subscription) {
                pushSubscriptions.set(body.sessionId || 'STUDENT', body.subscription);
            }
            return makeCorsResponse({ success: true, message: 'Subscription registered' });
        }
        if (url.pathname === '/api/push/test' && request.method === 'POST') {
            return makeCorsResponse({ success: true, message: 'Push triggered' });
        }

        // 10. Health check
        if (url.pathname === '/api/health') {
            return makeCorsResponse({ success: true, message: 'iSIM Lite Cloudflare Worker is healthy', engine: 'Cloudflare Workers Edge' });
        }

        // 11. Serve Static Assets (Frontend UI from www/)
        if (env.ASSETS) {
            return env.ASSETS.fetch(request);
        }

        return new Response('iSIM Lite Worker is Running. Send requests to /api/*', { status: 200 });
    }
};

