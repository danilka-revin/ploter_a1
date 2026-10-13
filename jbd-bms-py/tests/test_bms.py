import unittest

from jbd_bms import protocol as p
from jbd_bms.client import Bms
from jbd_bms.fake import FakeBms, FakeTransport
from jbd_bms.service import BmsService


class FrameTest(unittest.TestCase):
    def test_read_basic_frame_known_vector(self):
        # эталон из протокола JBD: чтение регистра 0x03
        self.assertEqual(p.build_read(0x03), bytes.fromhex("DDA50300FFFD77"))

    def test_extract_skips_garbage_and_bad_checksum(self):
        good = FakeBms()._answer(p.OP_READ, 0x05, b"")
        bad = bytearray(good)
        bad[-3] ^= 0xFF
        frames, rest = p.extract_responses(b"\x01\x02" + bytes(bad) + good + b"\xdd\x03")
        self.assertEqual(len(frames), 1)
        self.assertEqual(frames[0].reg, 0x05)
        self.assertEqual(rest, b"\xdd\x03")

    def test_partial_frame_is_kept(self):
        full = FakeBms()._answer(p.OP_READ, 0x04, b"")
        frames, rest = p.extract_responses(full[:5])
        self.assertEqual(frames, [])
        self.assertEqual(rest, full[:5])


class DecodeTest(unittest.TestCase):
    def test_temperature_scale(self):
        self.assertEqual(p.decode_temp(2731 + 254), 25.4)
        self.assertEqual(p.encode_temp(-5.5), 2731 - 55)

    def test_setting_steps_are_enforced(self):
        covp = p.SETTINGS_BY_KEY["covp"]
        self.assertEqual(p.setting_to_raw(covp, 3600), 3600)
        cap = p.SETTINGS_BY_KEY["design_cap"]
        self.assertEqual(p.setting_to_raw(cap, 100000), 10000)
        with self.assertRaises(p.ProtocolError):
            p.setting_to_raw(cap, 100005)  # шаг регистра 10 мАч
        covp_pack = p.SETTINGS_BY_KEY["povp"]
        with self.assertRaises(p.ProtocolError):
            p.setting_to_raw(covp_pack, 43805)

    def test_check_setting_value_limits(self):
        self.assertIsNone(p.check_setting_value("covp", 3650))
        self.assertIn("допустимо", p.check_setting_value("covp", 5000))
        self.assertIsNotNone(p.check_setting_value("cell_cnt", 12))  # не записывается
        self.assertIsNotNone(p.check_setting_value("covp", float("nan")))

    def test_consistency_rules(self):
        ok = {"covp": 3650, "covp_rel": 3350, "cuvp": 2500, "cuvp_rel": 2900}
        self.assertEqual(p.check_consistency(ok), [])
        bad = dict(ok, covp_rel=3700)
        self.assertTrue(p.check_consistency(bad))

    def test_password_rules(self):
        self.assertEqual(p.password_bytes(""), bytes(6))
        self.assertEqual(p.password_bytes("123456"), b"123456")
        with self.assertRaises(p.ProtocolError):
            p.password_bytes("123")

    def test_parse_basic_fields(self):
        b = FakeBms()
        data = b._basic_payload(b.state())
        basic = p.parse_basic(data)
        self.assertEqual(basic.cell_count, 12)
        self.assertAlmostEqual(basic.pack_voltage, 39.7, delta=0.5)
        self.assertEqual(basic.temperatures, [25.4, 26.1])
        self.assertTrue(basic.charge_fet_on and basic.discharge_fet_on)

    def test_fet_and_capacity_encoding(self):
        self.assertEqual(p.fet_raw(True, True), 0)
        self.assertEqual(p.fet_raw(False, True), 1)
        self.assertEqual(p.fet_raw(True, False), 2)
        self.assertEqual(p.cap_rem_raw(62.0), 6200)


class ClientTest(unittest.TestCase):
    def setUp(self):
        self.dev = FakeBms()
        self.t = FakeTransport(self.dev, latency=0)
        self.bms = Bms(self.t)

    def test_read_everything(self):
        self.assertEqual(len(self.bms.cells()), 12)
        self.assertEqual(self.bms.device_name(), "DEMO JBD 12S")
        self.assertIn("covp", self.bms.error_counters())
        self.assertEqual(self.bms.read_setting(p.SETTINGS_BY_KEY["covp"]), 3650)

    def test_write_requires_password(self):
        dev = FakeBms(password="123456")
        bms = Bms(FakeTransport(dev, latency=0))
        covp = p.SETTINGS_BY_KEY["covp"]
        with self.assertRaises(p.ProtocolError):
            bms.write_settings([(covp.reg, 3600)], password="000000")
        self.assertFalse(dev.factory)
        bms.write_settings([(covp.reg, 3600)], password="123456")
        self.assertEqual(bms.read_setting(covp), 3600)
        self.assertEqual(dev.saves, 1)

    def test_write_without_save_discards(self):
        covp = p.SETTINGS_BY_KEY["covp"]
        self.bms.write_settings([(covp.reg, 3600)], save=False)
        self.assertEqual(self.dev.saves, 0)
        self.assertEqual(self.bms.read_setting(covp), 3650)

    def test_fet_and_capacity(self):
        self.bms.set_fet(False, True)
        basic = self.bms.basic()
        self.assertFalse(basic.charge_fet_on)
        self.assertTrue(basic.discharge_fet_on)
        self.bms.set_capacity(55.5)
        self.assertAlmostEqual(self.bms.basic().remaining_ah, 55.5)

    def test_clear_errors_saves(self):
        self.dev.error_counts[0] = 7
        self.bms.clear_errors()
        self.assertEqual(self.bms.error_counters()["sc"], 0)
        self.assertEqual(self.dev.saves, 1)

    def test_no_reply_raises(self):
        class Silent:
            def write(self, d): pass
            def read(self, t):
                import time; time.sleep(min(t, 0.01)); return b""
            def close(self): pass
        bms = Bms(Silent(), timeout=0.1, retries=0)
        with self.assertRaises(p.ProtocolError):
            bms.basic()


class ServiceTest(unittest.TestCase):
    def test_poll_command_and_csv(self):
        import os, tempfile, time
        dev = FakeBms()
        svc = BmsService(lambda: FakeTransport(dev, latency=0), interval=0.05)
        svc.start()
        try:
            deadline = time.time() + 5
            while svc.latest is None and time.time() < deadline:
                time.sleep(0.02)
            self.assertTrue(svc.connected)
            self.assertEqual(len(svc.latest.cells), 12)
            covp = p.SETTINGS_BY_KEY["covp"]
            svc.run(lambda b: b.write_settings([(covp.reg, 3620)], save=True)).result(5)
            self.assertEqual(svc.run(lambda b: b.read_setting(covp)).result(5), 3620)
            fd, path = tempfile.mkstemp(suffix=".csv")
            os.close(fd)
            try:
                self.assertGreater(svc.export_csv(path), 0)
                self.assertIn("ячейка_12_мВ", open(path, encoding="utf-8-sig").readline())
            finally:
                os.unlink(path)
        finally:
            svc.stop()

    def test_command_without_link_fails(self):
        svc = BmsService(lambda: (_ for _ in ()).throw(OSError("нет порта")), interval=0.05)
        fut = svc.run(lambda b: b.basic())
        with self.assertRaises(p.ProtocolError):
            fut.result(5)


if __name__ == "__main__":
    unittest.main()
