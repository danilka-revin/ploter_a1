"""Тема оформления — те же цвета и шрифты, что в linux_pcb_app (тёмная и светлая)."""

from __future__ import annotations

DARK = dict(
    page="#0f1115", surface="#15181e", surface2="#1c2027", hover="#232833",
    line="#2a3038", line_soft="#232833", text="#edf0f4", text2="#c2cad3", muted="#97a1ad",
    accent="#ffc233", accent_ink="#1d1602", accent_soft="#33290f",
    ok="#7ddc52", ok_bg="#1d3a1a", warn="#e9c66e", warn_bg="#3a3216",
    danger="#e05548", danger_bg="#3d1d1b", danger_ink="#ff9a9d", info_bg="#20242c",
    code_bg="#0b0e12",
)

LIGHT = dict(
    page="#eef0f3", surface="#ffffff", surface2="#f4f6f9", hover="#e9edf2",
    line="#d8dde4", line_soft="#e3e7ed", text="#1c232c", text2="#39424d", muted="#5c6773",
    accent="#e08e00", accent_ink="#221a05", accent_soft="#fff1d6",
    ok="#2e7d32", ok_bg="#e3f3e1", warn="#8a5a00", warn_bg="#fff4d6",
    danger="#c62828", danger_bg="#fde7e5", danger_ink="#b71c1c", info_bg="#f0f2f5",
    code_bg="#f4f6f9",
)

FONT_STACK = '"Inter", "Manrope", "Segoe UI", "Ubuntu", "Cantarell", "DejaVu Sans", sans-serif'


def palette(name: str) -> dict:
    return DARK if name == "dark" else LIGHT


def stylesheet(name: str) -> str:
    c = palette(name)
    return f"""
* {{ font-family: {FONT_STACK}; font-size: 13px; color: {c['text']}; }}
QMainWindow, QWidget#root, QScrollArea, QScrollArea > QWidget > QWidget {{ background: {c['page']}; }}
QLabel {{ background: transparent; }}
QLabel[role="muted"] {{ color: {c['muted']}; }}
QLabel[role="small"] {{ font-size: 12px; }}
QLabel[role="tiny"] {{ font-size: 11px; color: {c['muted']}; }}
QLabel[role="title"] {{ font-size: 15px; font-weight: 600; }}
QLabel[role="big"] {{ font-size: 46px; font-weight: 700; }}
QLabel[role="unit"] {{ font-size: 20px; color: {c['muted']}; font-weight: 500; }}
QLabel[role="value"] {{ font-size: 22px; font-weight: 650; }}
QLabel[role="caption"] {{ font-size: 11px; color: {c['muted']}; }}
QLabel[tone="pos"] {{ color: {c['ok']}; }}
QLabel[tone="neg"] {{ color: {c['accent']}; }}
QLabel[tone="bad"] {{ color: {c['danger_ink']}; }}
QLabel[tone="warn"] {{ color: {c['warn']}; }}
QLabel[role="app"] {{ font-size: 16px; font-weight: 700; color: {c['accent']}; }}

QFrame[card="true"] {{
    background: {c['surface']}; border: 1px solid {c['line']}; border-radius: 12px;
}}
QFrame[card="true"] QLabel[role="section"] {{ font-size: 14px; font-weight: 600; }}
QFrame[tile="true"] {{
    background: {c['surface2']}; border: 1px solid {c['line_soft']}; border-radius: 10px;
}}
QFrame[tile="true"][state="balance"] {{ border: 1px solid {c['accent']}; }}
QFrame[tile="true"][state="low"] {{ border: 1px solid {c['danger']}; }}
QFrame[tile="true"][state="high"] {{ border: 1px solid {c['warn']}; }}
QFrame[fact="true"] {{ background: transparent; }}
QFrame[sep="true"] {{ background: {c['line']}; max-height: 1px; min-height: 1px; border: none; }}

QLabel[pill="true"] {{
    border-radius: 999px; padding: 3px 10px; font-size: 12px; font-weight: 600;
    background: {c['info_bg']}; color: {c['text2']};
}}
QLabel[pill="ok"] {{ background: {c['ok_bg']}; color: {c['ok']}; }}
QLabel[pill="bad"] {{ background: {c['danger_bg']}; color: {c['danger_ink']}; }}
QLabel[pill="warn"] {{ background: {c['warn_bg']}; color: {c['warn']}; }}
QLabel[pill="accent"] {{ background: {c['accent_soft']}; color: {c['accent']}; }}
QLabel[pill="off"] {{ background: {c['info_bg']}; color: {c['muted']}; }}

QLabel[banner="err"] {{ background: {c['danger_bg']}; color: {c['danger_ink']}; border-radius: 8px; padding: 8px 12px; }}
QLabel[banner="ok"] {{ background: {c['ok_bg']}; color: {c['ok']}; border-radius: 8px; padding: 8px 12px; }}
QLabel[banner="info"] {{ background: {c['info_bg']}; color: {c['text2']}; border-radius: 8px; padding: 8px 12px; }}

QPushButton {{
    background: {c['surface2']}; border: 1px solid {c['line']}; border-radius: 8px;
    padding: 7px 14px; color: {c['text']};
}}
QPushButton:hover {{ background: {c['hover']}; }}
QPushButton:disabled {{ color: {c['muted']}; background: {c['surface']}; }}
QPushButton[primary="true"] {{ background: {c['accent']}; color: {c['accent_ink']}; border: 1px solid {c['accent']}; font-weight: 600; }}
QPushButton[primary="true"]:hover {{ background: {c['accent']}; }}
QPushButton[primary="true"]:disabled {{ background: {c['surface2']}; color: {c['muted']}; border: 1px solid {c['line']}; }}
QPushButton[danger="true"] {{ color: {c['danger_ink']}; }}
QPushButton[tab="true"] {{ background: transparent; border: none; border-bottom: 2px solid transparent; border-radius: 0; padding: 10px 14px; color: {c['muted']}; font-weight: 600; }}
QPushButton[tab="true"]:checked {{ color: {c['text']}; border-bottom: 2px solid {c['accent']}; }}
QPushButton[tab="true"]:hover {{ color: {c['text']}; }}
QPushButton[flat="true"] {{ background: transparent; border: none; color: {c['muted']}; padding: 4px 8px; }}

QComboBox, QLineEdit, QPlainTextEdit, QSpinBox, QDoubleSpinBox {{
    background: {c['surface2']}; border: 1px solid {c['line']}; border-radius: 8px; padding: 6px 10px; min-height: 18px;
    selection-background-color: {c['accent']}; selection-color: {c['accent_ink']};
}}
QLineEdit[bad="true"] {{ border: 1px solid {c['danger']}; }}
QComboBox::drop-down {{ border: none; width: 22px; }}
QComboBox QAbstractItemView {{ background: {c['surface']}; border: 1px solid {c['line']}; selection-background-color: {c['hover']}; color: {c['text']}; }}
QCheckBox {{ spacing: 8px; }}
QCheckBox::indicator {{ width: 16px; height: 16px; border-radius: 4px; border: 1px solid {c['line']}; background: {c['surface2']}; }}
QCheckBox::indicator:checked {{ background: {c['accent']}; border: 1px solid {c['accent']}; }}

QTableWidget {{
    background: {c['surface']}; border: 1px solid {c['line']}; border-radius: 10px; gridline-color: {c['line_soft']};
    alternate-background-color: {c['surface2']}; selection-background-color: {c['hover']}; selection-color: {c['text']};
}}
QTableWidget::item {{ padding: 4px 8px; border: none; }}
QHeaderView::section {{
    background: {c['surface']}; color: {c['muted']}; border: none; border-bottom: 1px solid {c['line']};
    padding: 6px 8px; font-size: 12px; font-weight: 600;
}}
QTabWidget::pane {{ border: none; }}
QTabBar {{ background: transparent; }}
QScrollBar:vertical {{ background: transparent; width: 10px; margin: 0; }}
QScrollBar::handle:vertical {{ background: {c['line']}; border-radius: 5px; min-height: 30px; }}
QScrollBar::add-line, QScrollBar::sub-line {{ height: 0; }}
QScrollBar:horizontal {{ background: transparent; height: 10px; }}
QScrollBar::handle:horizontal {{ background: {c['line']}; border-radius: 5px; min-width: 30px; }}
QScrollBar::add-line, QScrollBar::sub-line {{ width: 0; }}
QProgressBar {{ background: {c['surface2']}; border: none; border-radius: 4px; text-align: center; color: transparent; max-height: 8px; min-height: 8px; }}
QProgressBar::chunk {{ background: {c['accent']}; border-radius: 4px; }}
QProgressBar[soc="true"]::chunk {{ background: {c['ok']}; }}
QProgressBar[tile="true"] {{ max-height: 6px; min-height: 6px; background: {c['line_soft']}; }}
QProgressBar[tile="true"]::chunk {{ background: {c['muted']}; }}
QProgressBar[tile="true"][state="balance"]::chunk {{ background: {c['accent']}; }}
QProgressBar[tile="true"][state="low"]::chunk {{ background: {c['danger']}; }}
QProgressBar[tile="true"][state="high"]::chunk {{ background: {c['warn']}; }}
QMenu {{ background: {c['surface']}; border: 1px solid {c['line']}; }}
QToolTip {{ background: {c['surface']}; color: {c['text']}; border: 1px solid {c['line']}; padding: 6px; }}
QStatusBar {{ background: {c['surface']}; border-top: 1px solid {c['line']}; color: {c['muted']}; }}
QStatusBar QLabel {{ color: {c['muted']}; }}
QDialog {{ background: {c['page']}; }}
"""
