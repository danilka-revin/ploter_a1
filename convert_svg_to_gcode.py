#!/usr/bin/env python3
"""
convert_svg_to_gcode.py
Конвертирует SVG-файл в базовый G-код для ручного плоттера.
Подходит для Bambu Lab A1 с креплением для ручки.

Использование:
    python3 convert_svg_to_gcode.py input.svg [output.gcode]

Параметры:
    - Скорость рисования по умолчанию: 1500 мм/мин
    - Подъём ручки: Z=5 мм
    - Опускание ручки (касание бумаги): Z=0 мм
"""

import sys
import xml.etree.ElementTree as ET
import math
import re


def parse_path_data(d):
    """Разбирает простые SVG path данные (M, L, C, Q) в точки."""
    points = []
    # Простая регулярка для извлечения координат — работает для базовых путей
    # Для полноценного SVG-to-G-code нужен полноценный парсер
    # Здесь мы используем приближённый подход для демонстрации
    commands = re.findall(r'([MLCQL])\s*([^MLCQL]+)', d)
    current = (0, 0)
    for cmd, coords_str in commands:
        coords = list(map(float, re.findall(r'-?\d+\.?\d*', coords_str)))
        if cmd == 'M':
            current = (coords[0], coords[1])
            points.append(current)
        elif cmd == 'L':
            current = (coords[0], coords[1])
            points.append(current)
        elif cmd == 'C':
            # Кубическая кривая — добавляем конечную точку для упрощения
            current = (coords[-2], coords[-1])
            points.append(current)
        elif cmd == 'Q':
            # Квадратичная кривая
            current = (coords[-2], coords[-1])
            points.append(current)
    return points


def svg_to_gcode(svg_path, output_path, feedrate=1500, z_up=5, z_down=0):
    tree = ET.parse(svg_path)
    root = tree.getroot()
    ns = {'svg': 'http://www.w3.org/2000/svg'}

    gcode = [
        "; G-код для Bambu Lab A1 с ручкой",
        "; Сгенерировано Почерк A1",
        "G21 ; миллиметры",
        "G90 ; абсолютные координаты",
        "G28 ; домашняя позиция",
        f"G0 Z{z_up} ; поднять ручку",
    ]

    # Извлекаем viewBox для масштабирования
    width = float(root.get('width', '800').replace('px', '').replace('mm', ''))
    height = float(root.get('height', '600').replace('px', '').replace('mm', ''))
    viewbox = root.get('viewBox', f'0 0 {width} {height}')
    vb = list(map(float, viewbox.split()))
    vb_w, vb_h = vb[2], vb[3]

    # Масштабируем в миллиметры (предполагаем 1 SVG px ≈ 0.3 мм для бумаги A4)
    scale = 0.3

    # Находим все элементы text и path
    elements = root.findall('.//{http://www.w3.org/2000/svg}text', ns) + \
               root.findall('.//{http://www.w3.org/2000/svg}path', ns)

    y_offset = 20  # отступ сверху в мм
    y_step = 12

    for idx, elem in enumerate(elements):
        tag = elem.tag.split('}')[-1] if '}' in elem.tag else elem.tag
        if tag == 'text':
            x = float(elem.get('x', 0))
            y = float(elem.get('y', 0)) * scale + y_offset
            text_content = elem.text or ''
            # Простое преобразование текста в линию
            gcode.append(f"; Текст: {text_content}")
            gcode.append(f"G0 X{x*scale + 10:.2f} Y{y:.2f}")
            gcode.append(f"G1 Z{z_down} F300 ; опустить ручку")
            # Двигаемся вправо на длину текста (примерная)
            length_approx = len(text_content) * 3
            gcode.append(f"G1 X{x*scale + 10 + length_approx:.2f} Y{y:.2f} F{feedrate}")
            gcode.append(f"G0 Z{z_up} ; поднять ручку")
            y_offset += y_step
        elif tag == 'path':
            d = elem.get('d', '')
            points = parse_path_data(d)
            if points:
                gcode.append(f"; Путь SVG (приближённый)")
                gcode.append(f"G0 X{points[0][0]*scale + 10:.2f} Y{points[0][1]*scale + y_offset:.2f}")
                gcode.append(f"G1 Z{z_down} F300")
                for px, py in points[1:]:
                    gcode.append(f"G1 X{px*scale + 10:.2f} Y{py*scale + y_offset:.2f} F{feedrate}")
                gcode.append(f"G0 Z{z_up} ; поднять ручку")
                y_offset += y_step

    gcode.append("G28 ; домой")
    gcode.append("M30 ; конец программы")

    output = '\n'.join(gcode)
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(output)
    print(f"G-код сохранён в: {output_path}")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Использование: python3 convert_svg_to_gcode.py <input.svg> [output.gcode]")
        sys.exit(1)
    input_file = sys.argv[1]
    output_file = sys.argv[2] if len(sys.argv) > 2 else 'pocherk_a1_homework.gcode'
    svg_to_gcode(input_file, output_file)
