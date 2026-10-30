"""First-launch UI handling never grants location or skips geometry assertions."""
import ast,re,unittest,xml.etree.ElementTree as ET
from pathlib import Path

class FirstLaunch(unittest.TestCase):
    def subject(self,checked='true',title='Remember photo locations?',intro=True):
        source=Path(__file__).with_name('probe_phone_stock_camera_successor.py').read_text()
        tree=ast.parse(source)
        functions=ast.Module(body=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in ('controls','dismiss_location_intro')],type_ignores=[])
        ns={'ET':ET,'re':re};exec(compile(functions,'probe','exec'),ns)
        xml='<hierarchy>'+('''<node text="%s"/><node resource-id="com.android.camera2:id/check_box" checked="%s" clickable="true" bounds="[56,498][664,583]"/><node resource-id="com.android.camera2:id/confirm_button" clickable="true" bounds="[216,1148][504,1244]"/>'''%(title,checked) if intro else '')+'</hierarchy>'
        calls=[]
        def cmd(*args):
            nonlocal xml
            calls.append(args)
            if args==('shell','input','tap','360','540'):xml=xml.replace('checked="true"','checked="false"')
            return xml.encode() if args[:2]==('exec-out','cat') else b''
        return ns['dismiss_location_intro'],cmd,calls
    def test_declines_selected_location(self):
        fn,cmd,calls=self.subject();self.assertTrue(fn(cmd))
        self.assertEqual([v for v in calls if v[:3]==('shell','input','tap')],[('shell','input','tap','360','540'),('shell','input','tap','360','1172')])
        self.assertFalse(any('grant' in v or 'settings' in v for v in calls))
    def test_unchecked_is_not_enabled(self):
        fn,cmd,calls=self.subject(checked='false');self.assertTrue(fn(cmd))
        self.assertEqual(len([v for v in calls if v[:3]==('shell','input','tap')]),1)
    def test_later_open_untouched(self):
        fn,cmd,calls=self.subject(intro=False);self.assertFalse(fn(cmd))
        self.assertFalse(any('tap' in v for v in calls))
    def test_unknown_screen_not_accepted(self):
        fn,cmd,calls=self.subject(title='Something else')
        with self.assertRaisesRegex(AssertionError,'unknown_camera_intro'):fn(cmd)
        self.assertFalse(any('tap' in v for v in calls))

if __name__=='__main__':unittest.main()
