"""Проверка окна в демо-режиме. Пропускается, если Qt недоступен (например, нет libGL)."""
import os
import sys
import time
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

try:
    from PySide6.QtWidgets import QApplication
    QT_OK = True
except Exception:  # нет системных библиотек Qt
    QT_OK = False


@unittest.skipUnless(QT_OK, "PySide6/Qt недоступен")
class MainWindowDemoTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication(sys.argv)

    def pump(self, sec):
        end = time.time() + sec
        while time.time() < end:
            self.app.processEvents()
            time.sleep(0.01)

    def test_demo_connects_and_fills_views(self):
        from jbd_bms.ui.app import Bridge, MainWindow
        win = MainWindow(Bridge(), demo=True)
        try:
            win.show()
            self.pump(2.5)
            self.assertIn("DEMO", win.status_pill.text())
            self.assertEqual(len(win.cells.tiles), 12)
            self.assertNotEqual(win.overview.voltage.text(), "—")
            win._set_tab(3)
            win.settings_view.read_all()
            self.pump(1.5)
            self.assertTrue(win.settings_view.loaded)
            self.assertTrue(win.settings_view.edits["covp"].text())
        finally:
            win.shutdown()
            win.close()


if __name__ == "__main__":
    unittest.main()
