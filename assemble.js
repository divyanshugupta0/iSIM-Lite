const fs = require('fs');
const path = require('path');

const styles = fs.readFileSync(path.join(__dirname, 'src', 'styles.css'), 'utf8');
const components = fs.readFileSync(path.join(__dirname, 'src', 'components.html'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, 'src', 'app.js'), 'utf8');
const originalHtml = fs.readFileSync(path.join(__dirname, 'index.html.bak'), 'utf8');

// Extract the original core script from originalHtml
const origScriptStart = originalHtml.indexOf('function getTodayIsoDate()');
const origScriptEnd = originalHtml.lastIndexOf('window.addEventListener(\'contextmenu\'');

if (origScriptStart === -1 || origScriptEnd === -1) {
    console.error('Could not locate original script bounds');
    process.exit(1);
}

const originalCoreScript = originalHtml.slice(origScriptStart, origScriptEnd);

// Assemble complete index.html
const assembledHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>iSIM Lite - Student Portal</title>
    <link rel="icon" href="https://www.glbitm.org/images/favicon.png" type="image/png">
    <link rel="manifest" href="manifest.json">
    <meta name="theme-color" content="#4f46e5">
    <meta name="mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
${styles}
    </style>
</head>
<body>

${components}

    <script>
${appJs}

${originalCoreScript}

        // --- ENHANCED NAVIGATION & HOOKS ---
        const originalSwitchMainTab = switchMainTab;
        switchMainTab = function(viewId, btn, updateRoute = true) {
            document.querySelectorAll('.view-section').forEach(el => el.classList.add('hidden'));
            document.getElementById(viewId)?.classList.remove('hidden');
            
            // Sync desktop tabs
            document.querySelectorAll('.nav-tab').forEach(el => el.classList.remove('active'));
            if (btn && btn.classList.contains('nav-tab')) btn.classList.add('active');

            // Sync mobile bottom nav
            document.querySelectorAll('.bottom-nav-item').forEach(el => el.classList.remove('active'));
            if (viewId === 'view-attendance') document.getElementById('bNavAttendance')?.classList.add('active');
            if (viewId === 'view-timetable') document.getElementById('bNavTimetable')?.classList.add('active');
            if (viewId === 'view-simulator') document.getElementById('bNavSimulator')?.classList.add('active');
            if (viewId === 'view-profile') document.getElementById('bNavProfile')?.classList.add('active');

            if (viewId === 'view-timetable') {
                if (updateRoute) setPageRoute('timetable');
                loadTimetableTab();
                return;
            }

            if (viewId === 'view-simulator') {
                if (updateRoute) setPageRoute('simulator');
                recalculateSimulation();
                return;
            }

            if (viewId === 'view-profile') {
                if (updateRoute) setPageRoute('profile');
                updateMpinStatusInProfile();
                updatePushStatusInProfile();
                initWorkerUrlUI();
                applyProfileCustomizations();
                if (!profileLoaded) fetchProfile(false);
                return;
            }

            originalSwitchMainTab(viewId, btn, updateRoute);
        };

        // Hook renderAttendanceTable to feed Simulator
        const originalRenderAttendanceTable = renderAttendanceTable;
        renderAttendanceTable = function(type, data, dateLabel = null, isSunday = false) {
            originalRenderAttendanceTable(type, data, dateLabel, isSunday);
            if (['monthly', 'semester'].includes(type) && data && data.length > 0) {
                populateSubjectBunkAnalytics(data);
            }
        };

        // Hook session restoration to support MPIN unlock on launch
        const originalRestoreSessionFromUrl = restoreSessionFromUrl;
        restoreSessionFromUrl = async function() {
            applyProfileCustomizations();
            const hasMpin = Boolean(localStorage.getItem(MPIN_STORAGE_KEY));
            if (!sessionId && hasMpin) {
                switchToMpinLogin();
                return;
            }
            await originalRestoreSessionFromUrl();
        };

        // Hook loginForm submit to trigger MPIN setup on first login
        const loginForm = document.getElementById('loginForm');
        loginForm.addEventListener('submit', async () => {
            setTimeout(() => {
                const hasMpin = Boolean(localStorage.getItem(MPIN_STORAGE_KEY));
                if (sessionId && !hasMpin) {
                    openSetupMpinModal();
                }
            }, 1200);
        });

        // Initialize theme
        applyInitialTheme();
        initThemeSwatches();
        applyProfileCustomizations();
        initWorkerUrlUI();

        window.addEventListener('contextmenu', (e) => {
            if (!('ontouchstart' in window || navigator.maxTouchPoints > 0)) {
                e.preventDefault();
            }
        });
    </script>
</body>
</html>
`;

fs.writeFileSync(path.join(__dirname, 'index.html'), assembledHtml, 'utf8');
console.log('Successfully assembled and wrote index.html!');

// Also copy to www/
require('./copy-assets.js');
