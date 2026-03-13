const API_BASE = 'https://api2.onfire.so';
let sessionCode = null;
let sessionData = null;
let slides = [];
let currentIndex = 0;
let pollInterval = null;
let qrPollInterval = null;
let qrTimerInterval = null;
let qrCode = null;
let qrExpiresAt = null;
let audioContext = null;
let analyser = null;
let currentSource = null;
let animationFrame = null;
let userHasInteracted = false;
let lastRemotePosition = null;
let lastSeekTs = null;
let ytPlayer = null;
let positionReportInterval = null;
let ytPlayGraceUntil = 0; // Timestamp: suppress pause/report during play transition

// Track user interaction for autoplay policy
function markUserInteraction() {
    if (userHasInteracted) return;
    userHasInteracted = true;
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }
}
document.addEventListener('click', markUserInteraction, { once: false });
document.addEventListener('touchstart', markUserInteraction, { once: false });
document.addEventListener('keydown', markUserInteraction, { once: false });

// Load YouTube IFrame API
(function() {
    var tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    var firstScript = document.getElementsByTagName('script')[0];
    firstScript.parentNode.insertBefore(tag, firstScript);
})();

let ytAPIReady = false;
window.onYouTubeIframeAPIReady = function() {
    ytAPIReady = true;
    console.log('YouTube IFrame API ready');
};

// --- Position reporting (display -> server) ---
function startPositionReporting() {
    stopPositionReporting();
    positionReportInterval = setInterval(reportPosition, 2000);
}

function stopPositionReporting() {
    if (positionReportInterval) {
        clearInterval(positionReportInterval);
        positionReportInterval = null;
    }
}

async function reportPosition() {
    if (!sessionCode) return;

    // During YouTube play grace period, don't report — avoids writing
    // playing:false back to server while YouTube is transitioning
    if (ytPlayer && Date.now() < ytPlayGraceUntil) return;

    var pos = 0;
    var dur = 0;
    var playing = false;

    var audio = document.getElementById('media-audio');
    var video = document.getElementById('media-video');

    if (ytPlayer && typeof ytPlayer.getCurrentTime === 'function') {
        try {
            pos = ytPlayer.getCurrentTime() || 0;
            dur = ytPlayer.getDuration() || 0;
            var state = ytPlayer.getPlayerState();
            playing = (state === 1); // YT.PlayerState.PLAYING
        } catch(e) {}
    } else if (audio) {
        pos = audio.currentTime || 0;
        dur = audio.duration || 0;
        playing = !audio.paused;
    } else if (video) {
        pos = video.currentTime || 0;
        dur = video.duration || 0;
        playing = !video.paused;
    } else {
        return; // No media element
    }

    if (dur <= 0) return; // Not loaded yet

    try {
        await fetch(API_BASE + '/rpc/update_presentation_state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                p_session_code: sessionCode,
                p_media_state: {
                    playing: playing,
                    position: Math.round(pos * 100) / 100,
                    duration: Math.round(dur * 100) / 100,
                    volume: 1.0
                }
            })
        });
    } catch(e) {
        // Silently fail - non-critical
    }
}

// --- QR Code Login Flow ---
async function init() {
    var stored = localStorage.getItem('display_session_code');
    if (stored) {
        try {
            var result = await fetchSession(stored);
            if (result && result.success) {
                sessionCode = stored;
                sessionData = result;
                slides = result.slides || [];
                showStartGate();
                return;
            }
        } catch (e) {
            console.error('Stored session invalid:', e);
        }
        localStorage.removeItem('display_session_code');
    }
    generateQR();
}

function showStartGate() {
    // Auto-start presentation immediately (no tap gate).
    // Fullscreen requires a user gesture, so we install a one-time click
    // handler — first tap/click anywhere on the display enters fullscreen.
    markUserInteraction();
    enterPresentation();
    installFullscreenOnTap();
}

/// One-time handler: first tap on the presentation screen enters fullscreen
function installFullscreenOnTap() {
    var screen = document.getElementById('presentation-screen');
    function goFullscreen() {
        screen.removeEventListener('click', goFullscreen);
        try {
            document.documentElement.requestFullscreen().catch(function(){});
        } catch(e) {}
    }
    screen.addEventListener('click', goFullscreen);
}

async function generateQR() {
    try {
        var ip = await getClientIP();
        var res = await fetch(API_BASE + '/rpc/generate_qr_session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ p_ip_address: ip, p_user_agent: navigator.userAgent })
        });
        var data = await res.json();
        if (data.success) {
            qrCode = data.qr_code;
            qrExpiresAt = new Date(Date.now() + 60000);
            renderQR(qrCode);
            startQRPolling();
            startQRTimer();
            document.getElementById('qr-status').textContent = 'Scan with OnFire app to connect';
        }
    } catch (e) {
        document.getElementById('qr-status').textContent = 'Error generating QR. Retrying...';
        setTimeout(generateQR, 3000);
    }
}

function renderQR(code, canvasId) {
    var canvas = document.getElementById(canvasId || 'qr-canvas');
    if (!canvas) return;
    var qr = qrcode(0, 'M');
    qr.addData(code);
    qr.make();
    var size = 250;
    var ctx = canvas.getContext('2d');
    canvas.width = size;
    canvas.height = size;
    var cellSize = size / qr.getModuleCount();
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000';
    for (var r = 0; r < qr.getModuleCount(); r++) {
        for (var c = 0; c < qr.getModuleCount(); c++) {
            if (qr.isDark(r, c)) {
                ctx.fillRect(c * cellSize, r * cellSize, cellSize + 0.5, cellSize + 0.5);
            }
        }
    }
}

function startQRPolling() {
    stopQRPolling();
    checkQRStatus();
    qrPollInterval = setInterval(checkQRStatus, 2000);
}

function stopQRPolling() {
    if (qrPollInterval) { clearInterval(qrPollInterval); qrPollInterval = null; }
    if (qrTimerInterval) { clearInterval(qrTimerInterval); qrTimerInterval = null; }
}

async function checkQRStatus() {
    if (!qrCode) return;
    try {
        var res = await fetch(API_BASE + '/rpc/check_qr_status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ p_qr_code: qrCode })
        });
        var data = await res.json();
        if (data.success && data.status === 'confirmed' && data.display_id) {
            stopQRPolling();
            localStorage.setItem('onfire_access_token', data.jwt_token);
            localStorage.setItem('onfire_display_id', data.display_id);

            var sessionRes = await fetch(API_BASE + '/rpc/create_presentation_session', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + data.jwt_token
                },
                body: JSON.stringify({ p_display_id: data.display_id, p_user_id: data.user_id || '' })
            });
            var sessionResult = await sessionRes.json();

            if (sessionResult && sessionResult.success) {
                sessionCode = sessionResult.session_code;
                localStorage.setItem('display_session_code', sessionCode);
                var fullSession = await fetchSession(sessionCode);
                if (fullSession && fullSession.success) {
                    sessionData = fullSession;
                    slides = fullSession.slides || [];
                    showStartGate();
                }
            } else {
                await loadSlidesDirectly(data.display_id, data.jwt_token);
            }
        } else if (data.status === 'expired') {
            // Regenerate on whichever screen is active
            if (document.getElementById('end-screen').classList.contains('active')) {
                generateEndScreenQR();
            } else {
                generateQR();
            }
        }
    } catch (e) {
        console.error('QR status error:', e);
    }
}

async function loadSlidesDirectly(displayId, token) {
    try {
        var res = await fetch(
            API_BASE + '/displays?id=eq.' + displayId + '&select=*,user_slides(*,slides(*))',
            { headers: { 'Authorization': 'Bearer ' + token } }
        );
        var displays = await res.json();
        if (displays.length > 0) {
            var display = displays[0];
            var userSlides = display.user_slides || [];
            slides = userSlides
                .filter(function(s) { return s.status === 'active'; })
                .sort(function(a, b) { return a.slide_order - b.slide_order; })
                .map(function(us) {
                    return {
                        id: us.id,
                        title: us.title || (us.slides ? us.slides.title : 'Slide'),
                        slide_type: us.slides ? us.slides.slide_type : 'html',
                        icon: us.icon || (us.slides ? us.slides.icon : ''),
                        duration_seconds: us.duration_seconds || 10,
                        settings: us.settings || {},
                        background_picture: us.background_picture,
                        external_slide_url: us.external_slide_url
                    };
                });
            showStartGate();
        }
    } catch (e) {
        console.error('Direct load error:', e);
    }
}

function startQRTimer() {
    if (qrTimerInterval) clearInterval(qrTimerInterval);
    qrTimerInterval = setInterval(function() {
        if (!qrExpiresAt) return;
        var remaining = Math.max(0, qrExpiresAt - Date.now());
        var secs = Math.floor(remaining / 1000);
        var el = document.getElementById('qr-timer');
        if (secs > 0) {
            el.textContent = 'Refreshes in ' + secs + 's';
        } else {
            el.textContent = '';
            generateQR();
        }
    }, 1000);
}

function connectWithCode() {
    var input = document.getElementById('session-input');
    var code = input.value.trim();
    if (!code) return;
    markUserInteraction();
    fetchSession(code).then(function(result) {
        if (result && result.success) {
            sessionCode = code;
            sessionData = result;
            slides = result.slides || [];
            localStorage.setItem('display_session_code', code);
            stopQRPolling();
            enterPresentation();
            try { document.documentElement.requestFullscreen().catch(function(){}); } catch(e) {}
        } else {
            input.style.borderColor = '#ef4444';
            setTimeout(function() { input.style.borderColor = '#333'; }, 2000);
        }
    });
}

async function fetchSession(code) {
    var res = await fetch(API_BASE + '/rpc/get_presentation_session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_session_code: code })
    });
    return res.json();
}

async function getClientIP() {
    try {
        var r = await fetch('https://api.ipify.org?format=json');
        var d = await r.json();
        return d.ip;
    } catch(e) {
        return '0.0.0.0';
    }
}

// --- Presentation Mode ---
function enterPresentation() {
    document.getElementById('connect-screen').classList.remove('active');
    document.getElementById('end-screen').classList.remove('active');
    document.getElementById('presentation-screen').classList.add('active');

    if (slides.length === 0) {
        showWelcome();
        return;
    }

    currentIndex = sessionData ? (sessionData.current_slide_index || 0) : 0;
    if (currentIndex >= slides.length) currentIndex = 0;

    renderSlide(currentIndex);
    startPolling();
}

function showWelcome() {
    var container = document.getElementById('slide-container');
    var msg = (sessionData && sessionData.display && sessionData.display.welcome_message) ? sessionData.display.welcome_message : 'Display Connected';
    container.innerHTML = '<div class="welcome-screen"><h1>' + msg + '</h1><p>Waiting for slides...</p></div>';
}

function renderSlide(index) {
    if (index < 0 || index >= slides.length) return;
    currentIndex = index;
    var slide = slides[index];
    var container = document.getElementById('slide-container');
    var counter = document.getElementById('slide-counter');
    counter.textContent = (index + 1) + ' / ' + slides.length;

    var indicator = document.getElementById('slide-indicator');
    indicator.classList.add('visible');
    setTimeout(function() { indicator.classList.remove('visible'); }, 2000);

    // Cleanup previous media (audio, video, YouTube, position reporting)
    cleanupMedia();

    var type = slide.slide_type || 'html';
    var settings = slide.settings || {};

    if (type === 'image' || settings.media_type === 'image') {
        var url = settings.media_url || settings.image_url || slide.background_picture || slide.external_slide_url || '';
        container.innerHTML = '<img src="' + url + '" alt="' + (slide.title || '') + '">';
    } else if (type === 'video' || settings.media_type === 'video') {
        var vurl = settings.media_url || settings.video_url || slide.external_slide_url || '';
        container.innerHTML = '<video id="media-video" crossorigin="anonymous" src="' + vurl + '" autoplay loop style="width:100%;height:100%;object-fit:contain;"></video>';
        startPositionReporting();
    } else if (settings.media_type === 'audio' || (settings.media_url && settings.media_url.match(/\.(mp3|wav|ogg|m4a)$/i))) {
        renderAudioSlide(slide, settings);
        startPositionReporting();
    } else if (settings.media_type === 'youtube' || (settings.embed_url && settings.embed_url.match(/youtu/i))) {
        renderYouTubeSlide(slide, settings);
        startPositionReporting();
    } else if (settings.embed_url || settings.media_type === 'vimeo') {
        renderEmbedSlide(slide, settings);
    } else if (type === 'iframe') {
        var iurl = slide.external_slide_url || settings.iframe_url || '';
        container.innerHTML = '<iframe src="' + iurl + '" allow="autoplay; fullscreen"></iframe>';
    } else if (type === 'html') {
        container.innerHTML = settings.content_html || '<div class="welcome-screen"><h1>' + (slide.title || 'Slide') + '</h1></div>';
    } else {
        container.innerHTML = '<div class="welcome-screen"><div style="font-size:64px">' + (slide.icon || '') + '</div><h1>' + (slide.title || 'Slide') + '</h1></div>';
    }
}

function cleanupMedia() {
    // Stop position reporting
    stopPositionReporting();

    // Audio cleanup
    if (animationFrame) { cancelAnimationFrame(animationFrame); animationFrame = null; }
    if (currentSource) {
        try { currentSource.disconnect(); } catch(e) {}
        currentSource = null;
    }
    analyser = null;
    lastRemotePosition = null;
    lastSeekTs = null;

    // Pause and remove existing audio/video
    var audio = document.getElementById('media-audio');
    if (audio) { audio.pause(); audio.src = ''; }
    var video = document.getElementById('media-video');
    if (video) { video.pause(); video.src = ''; }

    // YouTube cleanup
    if (ytPlayer) {
        try { ytPlayer.destroy(); } catch(e) {}
        ytPlayer = null;
    }
}

function renderAudioSlide(slide, settings) {
    var url = settings.media_url || '';
    var title = slide.title || 'Audio';
    var container = document.getElementById('slide-container');

    var barsHTML = '';
    for (var i = 0; i < 64; i++) {
        barsHTML += '<div class="waveform-bar" style="height: 20px;" id="bar-' + i + '"></div>';
    }

    container.innerHTML = '<div class="audio-player">' +
        '<div class="audio-title">' + title + '</div>' +
        '<div class="waveform-container">' + barsHTML + '</div>' +
        '<div class="audio-progress"><div class="audio-progress-fill" id="audio-progress"></div></div>' +
        '<div class="audio-time" id="audio-time">Loading...</div>' +
        '<audio id="media-audio" crossorigin="anonymous" preload="auto"></audio>' +
    '</div>';

    var audio = document.getElementById('media-audio');

    audio.addEventListener('loadedmetadata', function() {
        var timeEl = document.getElementById('audio-time');
        if (timeEl) {
            timeEl.textContent = '0:00 / ' + formatTime(audio.duration);
        }
    });

    audio.addEventListener('timeupdate', function() {
        var prog = document.getElementById('audio-progress');
        var timeEl = document.getElementById('audio-time');
        if (prog && audio.duration) {
            prog.style.width = (audio.currentTime / audio.duration * 100) + '%';
        }
        if (timeEl) {
            timeEl.textContent = formatTime(audio.currentTime) + ' / ' + formatTime(audio.duration || 0);
        }
    });

    audio.addEventListener('error', function(e) {
        console.error('Audio load error:', audio.error);
        var timeEl = document.getElementById('audio-time');
        if (timeEl) timeEl.textContent = 'Error loading audio';
    });

    try {
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioContext.state === 'suspended') {
            audioContext.resume();
        }
        currentSource = audioContext.createMediaElementSource(audio);
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 128;
        currentSource.connect(analyser);
        analyser.connect(audioContext.destination);
        animateWaveform();
    } catch(e) {
        console.log('Audio visualization setup error (audio will still play):', e);
    }

    audio.src = url;
    audio.load();
    audio.play().then(function() {
        console.log('Audio playing');
    }).catch(function(e) {
        console.log('Auto-play blocked, will play on remote command:', e);
    });
}

function animateWaveform() {
    if (!analyser) return;
    var data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    for (var i = 0; i < Math.min(64, data.length); i++) {
        var bar = document.getElementById('bar-' + i);
        if (bar) {
            var h = Math.max(4, (data[i] / 255) * 180);
            bar.style.height = h + 'px';
        }
    }
    animationFrame = requestAnimationFrame(animateWaveform);
}

// --- YouTube IFrame API slide ---
function renderYouTubeSlide(slide, settings) {
    var url = settings.embed_url || '';
    var container = document.getElementById('slide-container');

    var ytMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/embed\/)([\w-]+)/);
    if (!ytMatch) {
        renderEmbedSlide(slide, settings);
        return;
    }

    var videoId = ytMatch[1];
    container.innerHTML = '<div id="yt-player-container" style="width:100%;height:100%;"></div>';

    function createPlayer() {
        ytPlayer = new YT.Player('yt-player-container', {
            width: '100%',
            height: '100%',
            videoId: videoId,
            playerVars: {
                autoplay: 1,
                controls: 0,
                enablejsapi: 1,
                modestbranding: 1,
                rel: 0,
                fs: 0,
                iv_load_policy: 3,
                playsinline: 1,
                origin: window.location.origin
            },
            events: {
                onReady: function(event) {
                    console.log('YouTube player ready');
                    // Ensure autoplay works: mute first (always allowed), then unmute
                    event.target.mute();
                    event.target.playVideo();
                    setTimeout(function() {
                        if (ytPlayer && typeof ytPlayer.unMute === 'function') {
                            ytPlayer.unMute();
                            ytPlayer.setVolume(100);
                        }
                    }, 500);
                },
                onStateChange: function(event) {
                    console.log('YouTube state:', event.data);
                }
            }
        });

        // Ensure the iframe gets allow="autoplay" attribute
        setTimeout(function() {
            var iframe = document.querySelector('#yt-player-container iframe');
            if (iframe) {
                iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture');
            }
        }, 100);
    }

    if (ytAPIReady) {
        createPlayer();
    } else {
        var waitCount = 0;
        var waitTimer = setInterval(function() {
            waitCount++;
            if (ytAPIReady) {
                clearInterval(waitTimer);
                createPlayer();
            } else if (waitCount > 50) {
                clearInterval(waitTimer);
                console.error('YouTube API failed to load');
                renderEmbedSlide(slide, settings);
            }
        }, 200);
    }
}

function renderEmbedSlide(slide, settings) {
    var url = settings.embed_url || '';
    var container = document.getElementById('slide-container');
    var embedUrl = '';

    var ytMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/embed\/)([\w-]+)/);
    if (ytMatch) {
        embedUrl = 'https://www.youtube.com/embed/' + ytMatch[1] + '?autoplay=1&enablejsapi=1&mute=0';
    }
    var vmMatch = url.match(/vimeo\.com\/(\d+)/);
    if (vmMatch) {
        embedUrl = 'https://player.vimeo.com/video/' + vmMatch[1] + '?autoplay=0';
    }

    if (embedUrl) {
        container.innerHTML = '<iframe id="media-embed" src="' + embedUrl + '" allow="autoplay; fullscreen; encrypted-media" allowfullscreen></iframe>';
    } else {
        container.innerHTML = '<iframe src="' + url + '" allow="autoplay; fullscreen"></iframe>';
    }
}

function formatTime(s) {
    if (isNaN(s)) return '0:00';
    var m = Math.floor(s / 60);
    var sec = Math.floor(s % 60);
    return m + ':' + (sec < 10 ? '0' : '') + sec;
}

// --- Polling for state updates ---
function startPolling() {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(pollState, 1500);
}

async function pollState() {
    if (!sessionCode) return;
    try {
        var result = await fetchSession(sessionCode);
        if (result && result.success) {
            if (result.current_slide_index !== currentIndex) {
                renderSlide(result.current_slide_index);
            }
            var ms = result.media_state || {};
            handleMediaState(ms);

            if (result.slides && result.slides.length !== slides.length) {
                slides = result.slides;
            }
        } else if (result && !result.success) {
            // Session ended — show thank you screen
            clearInterval(pollInterval);
            cleanupMedia();
            localStorage.removeItem('display_session_code');
            showEndScreen();
        }
    } catch (e) {
        console.error('Poll error:', e);
    }
}

function handleMediaState(ms) {
    // YouTube player
    if (ytPlayer && typeof ytPlayer.getPlayerState === 'function') {
        handleYouTubeMediaState(ms);
        return;
    }

    // Audio/Video elements
    var video = document.getElementById('media-video');
    var audio = document.getElementById('media-audio');
    var media = video || audio;

    if (!media) return;

    if (ms.playing && audioContext && audioContext.state === 'suspended') {
        audioContext.resume();
    }

    if (ms.playing && media.paused) {
        media.play().catch(function(e) { console.log('Play failed:', e); });
    } else if (ms.playing === false && !media.paused) {
        media.pause();
    }

    // Seek only on explicit seek_to commands from the remote (keyed by seek_ts)
    if (ms.seek_to !== undefined && ms.seek_ts && ms.seek_ts !== lastSeekTs) {
        lastSeekTs = ms.seek_ts;
        console.log('Seeking media to', ms.seek_to);
        media.currentTime = ms.seek_to;
    }

    if (ms.volume !== undefined) {
        media.volume = ms.volume;
    }
}

function handleYouTubeMediaState(ms) {
    if (!ytPlayer || typeof ytPlayer.getPlayerState !== 'function') return;

    var now = Date.now();
    var state = ytPlayer.getPlayerState();
    var isPlaying = (state === 1); // YT.PlayerState.PLAYING

    if (ms.playing === true && !isPlaying) {
        // Set grace period: ignore pause commands and suppress position reports
        // for 2s while YouTube transitions to playing state
        ytPlayGraceUntil = now + 2000;

        // Browsers block playVideo() from timer/async contexts.
        // Workaround: mute → play (muted autoplay always allowed) → unmute.
        try {
            var wasMuted = ytPlayer.isMuted();
            var prevVol = ytPlayer.getVolume();
            ytPlayer.mute();
            ytPlayer.playVideo();
            // Unmute after YouTube has started playing
            setTimeout(function() {
                if (ytPlayer && typeof ytPlayer.unMute === 'function') {
                    if (!wasMuted) ytPlayer.unMute();
                    ytPlayer.setVolume(prevVol || 100);
                }
            }, 800);
        } catch(e) {
            console.warn('YouTube play workaround failed:', e);
            ytPlayer.playVideo();
        }
    } else if (ms.playing === false && isPlaying) {
        // Don't pause during grace period (prevents feedback loop)
        if (now < ytPlayGraceUntil) {
            console.log('YouTube: ignoring pause during play grace period');
            return;
        }
        ytPlayer.pauseVideo();
    }

    // Seek only on explicit seek_to commands from the remote (keyed by seek_ts)
    if (ms.seek_to !== undefined && ms.seek_ts && ms.seek_ts !== lastSeekTs) {
        lastSeekTs = ms.seek_ts;
        console.log('YouTube seeking to', ms.seek_to);
        ytPlayer.seekTo(ms.seek_to, true);
    }

    if (ms.volume !== undefined) {
        try { ytPlayer.setVolume(ms.volume * 100); } catch(e) {}
    }
}

// --- Stop Presentation (from display UI) ---
function stopPresentation() {
    if (pollInterval) clearInterval(pollInterval);
    cleanupMedia();
    localStorage.removeItem('display_session_code');
    // End session on server so the phone remote also gets notified
    if (sessionCode) {
        var token = localStorage.getItem('onfire_access_token');
        if (token) {
            fetch(API_BASE + '/rpc/end_presentation_session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ p_session_code: sessionCode })
            }).catch(function(){});
        }
    }
    // Reset state and go back to QR
    document.getElementById('slide-container').innerHTML = '';
    document.getElementById('presentation-screen').classList.remove('active');
    document.getElementById('end-screen').classList.remove('active');
    document.getElementById('connect-screen').classList.add('active');
    sessionCode = null;
    sessionData = null;
    slides = [];
    currentIndex = 0;
    generateQR();
}

// --- End Screen ---
let endQRTimerInterval = null;

function showEndScreen() {
    document.getElementById('slide-container').innerHTML = '';
    document.getElementById('presentation-screen').classList.remove('active');
    document.getElementById('connect-screen').classList.remove('active');
    document.getElementById('end-screen').classList.add('active');

    // Exit fullscreen
    try {
        if (document.fullscreenElement) {
            document.exitFullscreen().catch(function(){});
        }
    } catch(e) {}

    // Reset session state
    sessionCode = null;
    sessionData = null;
    slides = [];
    currentIndex = 0;

    // Generate a fresh QR on the end screen right side
    generateEndScreenQR();

    // After 60 seconds, return to plain QR screen
    setTimeout(returnToQR, 60000);
}

async function generateEndScreenQR() {
    var statusEl = document.getElementById('end-qr-status');
    var timerEl = document.getElementById('end-qr-timer');
    try {
        var ip = await getClientIP();
        var res = await fetch(API_BASE + '/rpc/generate_qr_session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ p_ip_address: ip, p_user_agent: navigator.userAgent })
        });
        var data = await res.json();
        if (data.success) {
            qrCode = data.qr_code;
            qrExpiresAt = new Date(Date.now() + 60000);
            renderQR(qrCode, 'end-qr-canvas');
            startQRPolling();
            if (statusEl) statusEl.textContent = 'Scan with OnFire app to connect';

            // Timer for end screen QR
            if (endQRTimerInterval) clearInterval(endQRTimerInterval);
            endQRTimerInterval = setInterval(function() {
                if (!qrExpiresAt) return;
                var remaining = Math.max(0, qrExpiresAt - Date.now());
                var secs = Math.floor(remaining / 1000);
                if (timerEl) {
                    if (secs > 0) {
                        timerEl.textContent = 'Refreshes in ' + secs + 's';
                    } else {
                        timerEl.textContent = '';
                        generateEndScreenQR();
                    }
                }
            }, 1000);
        }
    } catch (e) {
        if (statusEl) statusEl.textContent = 'Error generating QR. Retrying...';
        setTimeout(generateEndScreenQR, 3000);
    }
}

function returnToQR() {
    if (endQRTimerInterval) { clearInterval(endQRTimerInterval); endQRTimerInterval = null; }
    document.getElementById('end-screen').classList.remove('active');
    document.getElementById('connect-screen').classList.add('active');
    // Reset and generate fresh QR on connect screen
    stopQRPolling();
    qrCode = null;
    generateQR();
}

// Start
document.addEventListener('DOMContentLoaded', init);
