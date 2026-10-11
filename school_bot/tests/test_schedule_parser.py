"""Проверки разбора расписания на реальных данных класса 10ит.

Запуск: cd school_bot && python -m unittest discover -s tests -v
"""
import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fixture_10it import NIKA_FIXTURE  # noqa: E402
from schedule_parser import (  # noqa: E402
    NoScheduleForDate,
    extract_nika_json,
    find_class_id,
    format_lessons,
    lessons_for_date,
)


class ParserTests(unittest.TestCase):
    def setUp(self):
        self.data = NIKA_FIXTURE
        self.class_id = find_class_id(self.data, "10ит")

    def test_class_id(self):
        self.assertEqual(self.class_id, "035")

    def test_monday_with_exchanges(self):
        # 12.10 (пн): замены - урок 1 добавлен, 3 и 5 с новым кабинетом, 6 отменён
        lessons = lessons_for_date(self.data, self.class_id, date(2026, 10, 12))
        nums = [l.num for l in lessons]
        self.assertEqual(nums, [1, 2, 3, 4, 5])
        self.assertEqual(lessons[0].items[0].subject, "История")
        self.assertEqual(lessons[0].items[0].teacher, "Гоголева СМ")
        self.assertEqual(lessons[0].items[0].room, "208")
        self.assertTrue(lessons[0].changed)
        self.assertEqual(lessons[2].items[0].room, "204")  # география в другом кабинете
        self.assertEqual(lessons[4].items[0].room, "108")  # инд.проект

    def test_monday_split_groups_order(self):
        lessons = lessons_for_date(self.data, self.class_id, date(2026, 10, 12))
        second = lessons[1]  # урок 2 - английский в двух подгруппах
        self.assertFalse(second.changed)
        self.assertEqual(
            [(i.group, i.subject, i.teacher, i.room) for i in second.items],
            [
                ("Группа 1", "Ин.яз.", "Боброва НВ", "312"),
                ("Группа 2", "Технический английский", "Шепелина ОС", "315"),
            ],
        )

    def test_tuesday_exchange_merges_groups_and_removes_lesson_7(self):
        lessons = lessons_for_date(self.data, self.class_id, date(2026, 10, 13))
        self.assertEqual([l.num for l in lessons], [1, 2, 3, 4, 5, 6])
        # Информатика в обеих подгруппах у одного учителя и в одном кабинете
        text = format_lessons(self.data, lessons)
        self.assertIn("1. 8:00–8:40 · Информатика — Межов АА, каб. 302 🔄", text)
        self.assertIn("6. 12:35–13:15 · Биология — Янчик СВ, каб. 210", text)
        self.assertFalse(any("Программирование" in line for line in text))

    def test_wednesday_base_schedule_subgroup_labels(self):
        lessons = lessons_for_date(self.data, self.class_id, date(2026, 10, 14))
        first = lessons[0]
        self.assertEqual(
            [(i.group, i.subject, i.teacher, i.room) for i in first.items],
            [
                ("1 группа", "Программирование", "Межов АА", "203"),
                ("2 группа", "Комп.проектирование", "Медведева АБ", "113"),
            ],
        )

    def test_sunday_has_no_lessons(self):
        # 11.10.2026 - воскресенье внутри периода: занятий нет
        self.assertEqual(lessons_for_date(self.data, self.class_id, date(2026, 10, 11)), [])

    def test_out_of_period_raises(self):
        with self.assertRaises(NoScheduleForDate):
            lessons_for_date(self.data, self.class_id, date(2026, 10, 26))

    def test_extract_nika_json(self):
        js = "// comment\nvar NIKA=\n{\"A\":1,\"B\":{\"C\":[1,2]}};\nfunction x(){}"
        self.assertEqual(extract_nika_json(js), {"A": 1, "B": {"C": [1, 2]}})


if __name__ == "__main__":
    unittest.main()
