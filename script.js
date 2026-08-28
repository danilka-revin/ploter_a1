/**
 * Почерк A1 — клиентская логика
 * Генерирует SVG и базовый G-код для ручного плоттера Bambu Lab A1.
 */

const canvas = document.getElementById('previewCanvas');
const ctx = canvas.getContext('2d');
const wrap = document.getElementById('previewWrap');

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
['textInput','fontSelect','tilt','size','spacing','lineHeight','stroke','inkColor'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => {
    updateOutputs();
    draw();
  });
});

// Загрузка образца
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
  };
}

function draw() {
  const s = getSettings();
  const width = wrap.getBoundingClientRect().width;
  const height = 600;

  // Очищаем холст
  ctx.fillStyle = '#fffdf5';
  ctx.fillRect(0, 0, width, height);

  // Рисуем линии для ориентира (как в тетради)
  ctx.strokeStyle = '#e8dcc8';
  ctx.lineWidth = 0.5;
  const lineGap = 40 * s.lineHeight;
  for (let y = 60; y < height; y += lineGap) {
    ctx.beginPath();
    ctx.moveTo(40, y);
    ctx.lineTo(width - 40, y);
    ctx.stroke();
  }

  // Настройки текста
  const fontSize = (16 * s.size) / 100;
  const family = s.font;
  ctx.font = `${fontSize}px ${family}`;
  ctx.fillStyle = s.color;
  ctx.textBaseline = 'middle';
  ctx.letterSpacing = (s.spacing - 1) * 6 + 'px';

  const lines = s.text.split('\n');
  let y = 80;
  const lineH = fontSize * s.lineHeight * 1.4;

  for (const line of lines) {
    if (line.trim() === '') {
      y += lineH * 0.7;
      continue;
    }
    // Применяем наклон через трансформацию
    ctx.save();
    ctx.translate(width / 2, y);
    ctx.rotate((s.tilt * Math.PI) / 180);
    ctx.textAlign = 'center';
    // Рисуем текст с имитацией «ручного» эффекта
    drawHandwrittenLine(ctx, line, 0, 0, fontSize, s);
    ctx.restore();
    y += lineH;
  }
}

function drawHandwrittenLine(ctx, text, cx, cy, fontSize, s) {
  // Рисуем текст как обычный, но добавляем эффект «дрожания» линии
  ctx.fillStyle = s.color;
  ctx.font = `${fontSize}px ${s.font}`;
  ctx.textAlign = 'center';
  ctx.fillText(text, cx, cy);
  // Дополнительно рисуем лёгкий контур для имитации толщины чернил
  ctx.lineWidth = s.stroke / 2;
  ctx.strokeStyle = s.color;
  ctx.lineJoin = 'round';
  ctx.strokeText(text, cx, cy);
}

// --- Экспорт ---

function exportSVG() {
  const s = getSettings();
  const lines = s.text.split('\n');
  const width = 800;
  const fontSize = (16 * s.size) / 100;
  const lineH = fontSize * s.lineHeight * 1.4;

  const svgHeight = Math.max(400, lines.length * lineH + 120);

  let textBlocks = '';
  let y = 80;
  for (const line of lines) {
    if (line.trim() === '') {
      y += lineH * 0.7;
      continue;
    }
    textBlocks += `
      <text x="${width/2}" y="${y}" text-anchor="middle"
            font-family="${s.font}" font-size="${fontSize}px"
            fill="${s.color}" letter-spacing="${(s.spacing-1)*6}">
        <tspan>${escapeXml(line)}</tspan>
      </text>
    `;
    // Добавляем контур для имитации толщины
    textBlocks += `
      <text x="${width/2}" y="${y}" text-anchor="middle"
            font-family="${s.font}" font-size="${fontSize}px"
            stroke="${s.color}" stroke-width="${s.stroke/2}" fill="none" letter-spacing="${(s.spacing-1)*6}">
        <tspan>${escapeXml(line)}</tspan>
      </text>
    `;
    y += lineH;
  }

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

function escapeXml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function exportGCode() {
  const s = getSettings();
  // Генерируем простой G-код из SVG-пути (упрощённый)
  // Этот код можно дополнить конвертером через Python
  const lines = s.text.split('\n');
  const gcodeLines = [
    '; G-код для Bambu Lab A1 с ручкой',
    '; Сгенерировано Почерк A1',
    'G21 ; миллиметры',
    'G90 ; абсолютные координаты',
    'G28 ; домашняя позиция',
    'G0 Z5 ; поднять ручку',
    'G0 X10 Y20 ; позиция начала',
    'G1 Z0 F300 ; опустить ручку (ручка касается бумаги)',
  ];
  let y = 30;
  for (const line of lines) {
    if (line.trim() === '') {
      y += 10;
      continue;
    }
    // Простая строка — двигаемся вправо, рисуя текст
    // В реальности нужен SVG-to-G-code конвертер
    const textLengthApprox = line.length * 4; // примерная ширина в мм
    gcodeLines.push(`G1 X${10 + textLengthApprox/2} Y${y} F1500`);
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

function printPage() {
  window.print();
}

// Инициализация
window.addEventListener('load', () => {
  resizeCanvas();
  updateOutputs();
  draw();
});
