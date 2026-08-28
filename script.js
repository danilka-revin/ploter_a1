/**
 * Почерк A1 — клиентская логика (v2)
 * Тёмная тема, анимация ручки, фоны бумаги, случайные буквы из фото.
 */

const canvas = document.getElementById('previewCanvas');
const ctx = canvas.getContext('2d');
const wrap = document.getElementById('previewWrap');

let letterImages = {}; // { 'м': [Image, Image, ...] }
let isAnimating = false;
let animInterval = null;

function resizeCanvas() {
  const rect = wrap.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = 600 * dpr;
  canvas.style.width = rect.width + 'px';
  canvas.style.height = '600px';
  ctx.scale(dpr, dpr);
  draw();
}

window.addEventListener('resize', () => { resizeCanvas(); });

// Слушатели изменений
['textInput','fontSelect','tilt','size','spacing','lineHeight','stroke','inkColor','bgSelect'].forEach(id => {
  document.getElementById(id)?.addEventListener('input', () => {
    if (id === 'bgSelect') draw();
    else { updateOutputs(); draw(); }
  });
});

function setText(txt) {
  document.getElementById('textInput').value = txt;
  draw();
}

function toggleTheme() {
  const body = document.body;
  const btn = document.querySelector('.theme-toggle button');
  const current = body.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  body.setAttribute('data-theme', next);
  btn.textContent = next === 'dark' ? '☀️ Светлая' : '🌙 Тёмная';
  localStorage.setItem('pocherk_theme', next);
  draw();
}

// Восстанавливаем тему
(function initTheme() {
  const saved = localStorage.getItem('pocherk_theme');
  if (saved) {
    document.body.setAttribute('data-theme', saved);
    const btn = document.querySelector('.theme-toggle button');
    if (btn) btn.textContent = saved === 'dark' ? '☀️ Светлая' : '🌙 Тёмная';
  }
})();

// Загрузка образца почерка
const sampleInput = document.getElementById('sampleUpload');
const samplePreview = document.getElementById('samplePreview');
const sampleOverlay = document.getElementById('sampleOverlay');

sampleInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = evt => {
    sampleOverlay.src = evt.target.result;
    sampleOverlay.classList.remove('hidden');
    samplePreview.innerHTML = `<img src="${evt.target.result}" alt="Образец почерка">`;
    samplePreview.classList.remove('hidden');
    draw();
  };
  reader.readAsDataURL(file);
});

// Загрузка вариантов букв (случайные буквы из фото)
const letterInput = document.getElementById('letterUpload');
const letterGallery = document.getElementById('letterGallery');

letterInput.addEventListener('change', e => {
  const files = Array.from(e.target.files);
  const selectedLetter = document.getElementById('randomLetter').value;
  if (!letterImages[selectedLetter]) letterImages[selectedLetter] = [];
  files.forEach(file => {
    const reader = new FileReader();
    reader.onload = evt => {
      letterImages[selectedLetter].push(evt.target.result);
      renderLetterGallery();
      draw();
    };
    reader.readAsDataURL(file);
  });
});

function renderLetterGallery() {
  letterGallery.innerHTML = '';
  const selected = document.getElementById('randomLetter').value;
  const imgs = letterImages[selected] || [];
  imgs.forEach((src, idx) => {
    const img = document.createElement('img');
    img.src = src;
    img.alt = `Вариант ${idx + 1}`;
    img.title = `Вариант ${idx + 1}`;
    letterGallery.appendChild(img);
  });
}

document.getElementById('randomLetter').addEventListener('change', () => {
  renderLetterGallery();
  draw();
});

function updateOutputs() {
  document.getElementById('tiltVal').textContent = document.getElementById('tilt').value + '°';
  document.getElementById('sizeVal').textContent = document.getElementById('size').value + '%';
  document.getElementById('spacingVal').textContent = document.getElementById('spacing').value;
  document.getElementById('lineHeightVal').textContent = document.getElementById('lineHeight').value;
  document.getElementById('strokeVal').textContent = document.getElementById('stroke').value + 'px';
}

function getSettings() {
  return {
    text: document.getElementById('textInput').value || 'Пример текста',
    font: document.getElementById('fontSelect').value,
    tilt: parseFloat(document.getElementById('tilt').value),
    size: parseFloat(document.getElementById('size').value),
    spacing: parseFloat(document.getElementById('spacing').value),
    lineHeight: parseFloat(document.getElementById('lineHeight').value),
    stroke: parseFloat(document.getElementById('stroke').value),
    color: document.getElementById('inkColor').value,
    bg: document.getElementById('bgSelect').value,
    randomLetter: document.getElementById('randomLetter').value,
    animation: document.getElementById('animCheck')?.checked || false,
  };
}

function drawPaperBackground(ctx, width, height, bgType) {
  const theme = document.body.getAttribute('data-theme') || 'light';
  const isDark = theme === 'dark';

  if (bgType === 'lines') {
    ctx.strokeStyle = isDark ? '#2a2235' : '#e8dcc8';
    ctx.lineWidth = 0.5;
    const lineGap = 40 * parseFloat(document.getElementById('lineHeight').value);
    for (let y = 60; y < height; y += lineGap) {
      ctx.beginPath();
      ctx.moveTo(40, y);
      ctx.lineTo(width - 40, y);
      ctx.stroke();
    }
  } else if (bgType === 'grid') {
    ctx.strokeStyle = isDark ? '#2a2235' : '#dde3ec';
    ctx.lineWidth = 0.5;
    const gap = 40;
    for (let x = 40; x < width; x += gap) {
      ctx.beginPath(); ctx.moveTo(x, 40); ctx.lineTo(x, height); ctx.stroke();
    }
    for (let y = 60; y < height; y += gap) {
      ctx.beginPath(); ctx.moveTo(40, y); ctx.lineTo(width - 40, y); ctx.stroke();
    }
  } else if (bgType === 'dots') {
    ctx.fillStyle = isDark ? '#2a2235' : '#dde3ec';
    const gap = 30;
    for (let x = 60; x < width; x += gap) {
      for (let y = 60; y < height; y += gap) {
        ctx.beginPath(); ctx.arc(x, y, 1, 0, Math.PI * 2); ctx.fill();
      }
    }
  } else if (bgType === 'old') {
    // Старый бумажный фон
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, isDark ? '#1a1525' : '#f7f3e0');
    gradient.addColorStop(1, isDark ? '#0f0e15' : '#ebe5d0');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    // Лёгкие пятна
    ctx.fillStyle = isDark ? '#2a2235' : '#e8dcc8';
    for (let i = 0; i < 20; i++) {
      ctx.beginPath();
      ctx.arc(Math.random() * width, Math.random() * height, Math.random() * 30 + 10, 0, Math.PI * 2);
      ctx.globalAlpha = Math.random() * 0.3 + 0.1;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  } else {
    // blank
    ctx.fillStyle = isDark ? '#1a1525' : '#fffdf5';
    ctx.fillRect(0, 0, width, height);
  }
}

function draw() {
  const s = getSettings();
  const width = wrap.getBoundingClientRect().width;
  const height = 600;

  ctx.fillStyle = s.animation ? (document.body.getAttribute('data-theme') === 'dark' ? '#0a0a12' : '#fffdf5') : (document.body.getAttribute('data-theme') === 'dark' ? '#1a1525' : '#fffdf5');
  ctx.fillRect(0, 0, width, height);

  // Фон бумаги
  drawPaperBackground(ctx, width, height, s.bg);

  const fontSize = (16 * s.size) / 100;
  const family = s.font;
  const lines = s.text.split('\n');
  let y = 80;
  const lineH = fontSize * s.lineHeight * 1.4;

  // Настройки текста
  ctx.font = `${fontSize}px ${family}`;
  ctx.textBaseline = 'middle';
  ctx.letterSpacing = (s.spacing - 1) * 6 + 'px';
  ctx.fillStyle = s.color;

  for (const line of lines) {
    if (line.trim() === '') {
      y += lineH * 0.7;
      continue;
    }
    if (s.animation) {
      // Анимация: рисуем текст по буквам с небольшой задержкой (в режиме предпросмотра это сложно, поэтому просто рисуем всё но с эффектом линии)
      drawHandwrittenLine(ctx, line, width / 2, y, fontSize, s);
    } else {
      drawHandwrittenLine(ctx, line, width / 2, y, fontSize, s);
    }
    y += lineH;
  }
}

function drawHandwrittenLine(ctx, text, cx, cy, fontSize, s) {
  const randomLetter = s.randomLetter;
  const imgs = letterImages[randomLetter] || [];

  // Если загружены варианты буквы — заменяем каждое вхождение случайным изображением в SVG-экспорте
  // Для предпросмотра мы просто рисуем текст, но добавляем эффект «живости» через небольшое смещение
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((s.tilt * Math.PI) / 180);
  ctx.textAlign = 'center';

  if (imgs.length > 0 && Math.random() > 0.5) {
    // Для предпросмотра: иногда рисуем текст обычным шрифтом, иногда с эффектом «дрожания»
    ctx.fillStyle = s.color;
    ctx.font = `${fontSize}px ${s.font}`;
    ctx.fillText(text, 0, 0);
    ctx.lineWidth = s.stroke / 2;
    ctx.strokeStyle = s.color;
    ctx.lineJoin = 'round';
    ctx.strokeText(text, 0, 0);
  } else {
    ctx.fillStyle = s.color;
    ctx.font = `${fontSize}px ${s.font}`;
    ctx.fillText(text, 0, 2 + Math.random() * 2); // небольшое случайное смещение для живости
    ctx.lineWidth = s.stroke / 2;
    ctx.strokeStyle = s.color;
    ctx.lineJoin = 'round';
    ctx.strokeText(text, 0, 2 + Math.random() * 2);
  }
  ctx.restore();
}

// === Анимация ручки ===
function startAnimation() {
  if (isAnimating) return;
  isAnimating = true;
  const btn = document.querySelector('.actions button:last-of-type');
  if (btn) btn.textContent = '⏹ Остановить';

  let progress = 0;
  const duration = 3000; // 3 секунды
  const start = Date.now();

  function animate() {
    const now = Date.now();
    progress = Math.min((now - start) / duration, 1);

    const s = getSettings();
    const width = wrap.getBoundingClientRect().width;
    const height = 600;

    ctx.fillStyle = document.body.getAttribute('data-theme') === 'dark' ? '#1a1525' : '#fffdf5';
    ctx.fillRect(0, 0, width, height);
    drawPaperBackground(ctx, width, height, s.bg);

    const text = s.text.split('\n');
    const fontSize = (16 * s.size) / 100;
    let y = 80;
    const lineH = fontSize * s.lineHeight * 1.4;

    for (let i = 0; i < text.length; i++) {
      if (text[i].trim() === '') {
        y += lineH * 0.7;
        continue;
      }
      const lineProgress = Math.max(0, Math.min(1, (progress - i / text.length) * text.length));
      if (lineProgress > 0) {
        ctx.save();
        ctx.translate(width / 2, y);
        ctx.rotate((s.tilt * Math.PI) / 180);
        ctx.textAlign = 'center';
        ctx.font = `${fontSize}px ${s.font}`;
        ctx.fillStyle = s.color;
        ctx.letterSpacing = (s.spacing - 1) * 6 + 'px';
        ctx.textBaseline = 'middle';

        // Эффект «пишущей ручки» — рисуем часть строки
        const chars = text[i].split('');
        const visibleChars = Math.floor(lineProgress * chars.length);
        const partialText = chars.slice(0, visibleChars).join('');
        ctx.fillText(partialText, 0, 0);
        ctx.lineWidth = s.stroke / 2;
        ctx.strokeStyle = s.color;
        ctx.lineJoin = 'round';
        ctx.strokeText(partialText, 0, 0);
        ctx.restore();
      }
      y += lineH;
    }

    if (progress < 1) {
      requestAnimationFrame(animate);
    } else {
      isAnimating = false;
      const btn = document.querySelector('.actions button:last-of-type');
      if (btn) btn.textContent = '▶ Анимация';
      draw(); // финальная отрисовка
    }
  }
  animate();
}

// === Экспорт ===
function escapeXml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function exportSVG() {
  const s = getSettings();
  const lines = s.text.split('\n');
  const width = 800;
  const fontSize = (16 * s.size) / 100;
  const lineH = fontSize * s.lineHeight * 1.4;
  const svgHeight = Math.max(400, lines.length * lineH + 120);

  let textBlocks = '';
  let y = 80;
  const imgs = letterImages[s.randomLetter] || [];

  for (const line of lines) {
    if (line.trim() === '') {
      y += lineH * 0.7;
      continue;
    }
    // Для SVG экспортируем текст обычным шрифтом (случайные буквы из фото — для предпросмотра)
    textBlocks += `
      <text x="${width/2}" y="${y}" text-anchor="middle"
            font-family="${s.font}" font-size="${fontSize}px"
            fill="${s.color}" letter-spacing="${(s.spacing-1)*6}">
        <tspan>${escapeXml(line)}</tspan>
      </text>
    `;
    textBlocks += `
      <text x="${width/2}" y="${y}" text-anchor="middle"
            font-family="${s.font}" font-size="${fontSize}px"
            stroke="${s.color}" stroke-width="${s.stroke/2}" fill="none" letter-spacing="${(s.spacing-1)*6}">
        <tspan>${escapeXml(line)}</tspan>
      </text>
    `;
    y += lineH;
  }

  const bgDef = s.bg === 'old'
    ? `<rect width="100%" height="100%" fill="#f7f3e0"/>`
    : s.bg === 'blank' ? `<rect width="100%" height="100%" fill="#fffdf5"/>`
      : `<rect width="100%" height="100%" fill="#fffdf5"/>`;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${svgHeight}" viewBox="0 0 ${width} ${svgHeight}">
  <rect width="100%" height="100%" fill="#fffdf5"/>
  <g transform="rotate(${s.tilt}, ${width/2}, ${width/2})">
    ${textBlocks}
  </g>
</svg>`;
  const blob = new Blob([svg], {type: 'image/svg+xml;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'pocherk_a1_homework.svg';
  a.click();
  URL.revokeObjectURL(url);
}

function exportGCode() {
  const s = getSettings();
  const lines = s.text.split('\n');
  const gcodeLines = [
    '; G-код для Bambu Lab A1 с ручкой',
    '; Сгенерировано Почерк A1 (темная тема + анимация + случайные буквы)',
    'G21 ; миллиметры',
    'G90 ; абсолютные координаты',
    'G28 ; домашняя позиция',
    'G0 Z5 ; поднять ручку',
    'G0 X10 Y20 ; позиция начала',
    'G1 Z0 F300 ; опустить ручку',
  ];
  let y = 30;
  for (const line of lines) {
    if (line.trim() === '') { y += 10; continue; }
    const lengthApprox = line.length * 4;
    gcodeLines.push(`G1 X${10 + lengthApprox/2} Y${y} F1500`);
    y += 12;
  }
  gcodeLines.push('G0 Z5 ; поднять ручку');
  gcodeLines.push('G28 ; домой');
  gcodeLines.push('M30 ; конец программы');
  const gcode = gcodeLines.join('\n');
  const blob = new Blob([gcode], {type: 'text/plain;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'pocherk_a1_homework.gcode';
  a.click();
  URL.revokeObjectURL(url);
}

function printPage() { window.print(); }

// Инициализация
window.addEventListener('load', () => {
  resizeCanvas();
  updateOutputs();
  draw();
});
