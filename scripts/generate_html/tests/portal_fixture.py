"""Serve a fixed forecast via the real renderer, live endpoint, and import database."""
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from threading import Thread

from core.live_server import ForecastServer, LiveMonitor
from core.renderer import forecast_manifest, render_dashboard
from modules.sales_forecast import TASKS


def fixture():
    name = '测试车型 A'
    target = {
        'name': name, 'tier': 'SUV', 'energy': '纯电', 'node': '新车',
        'launch_date': '2026-11-13', 'end_date': '2026-11-15', 'days': 3,
        'launch_days': 3, 'small': 100, 'total_small': 100, 'stage': 'active',
        'small_start_date': '2026-11-10', 'small_end_date': '2026-11-12',
        'steady_start_date': '2026-11-16', 'small_period': '晚上', 'launch_period': '晚上',
    }
    candidates = [{'model': label, 'tier': 'SUV', 'energy': energy, 'node': '新车', 'days': 3}
                  for label, energy in [('参考车型乙', '纯电'), ('参考车型丙', '增程')]]
    hourly = [None] * 20 + [.3, .6, .8, 1]
    launch_history = [dict(car, launch_date='2026-10-25', end_date='2026-10-27',
                           hourly_curve=hourly, daily_direct=[10, 6, 4]) for car in candidates]
    small_history = [dict(car, small_start_date='2026-10-22', total=100, daily_orders=[50, 30, 20],
                          small_progress=[.5, .8, 1], small_hourly_curve=hourly) for car in candidates]
    steady_history = [dict(car, daily=[{'date': f'2026-11-{day:02d}', 'lock': 10}
                                      for day in range(1, 8)]) for car in candidates]
    data = {'target': target, 'targets': [target], 'history': launch_history, 'actuals': [],
            'small_order_history': small_history, 'steady_history': steady_history,
            'tasks': [{'key': k, 'label': label, 'purpose': purpose} for k, label, purpose in TASKS],
            'tiers': ['SUV'], 'energies': ['纯电'], 'nodes': ['新车']}
    page = {'layout': 'workspace', 'workspace': {'kind': 'forecast_workspace', 'data': data},
            'sections': [], 'kpis': []}
    view = {'periods': ['预测方案'], 'default_period': '预测方案', 'pages': {'预测方案': page}}
    return forecast_manifest({
        'meta': {'generated_at': '2026-11-14T12:00:00'},
        'config': {'forecast_as_of_date': '2026-11-14', 'module_labels': {'sales_forecast': '销量预测'},
                   'grain_labels': {'day': '日', 'week': '周', 'month': '月'}},
        'subjects': [{'id': 'target', 'name': name, 'type': 'generation', 'modules': ['sales_forecast']}],
        'dashboards': {'target|sales_forecast': {'views': {'week': view}}},
    })


if __name__ == '__main__':
    with TemporaryDirectory(prefix='forecast-browser-') as temporary:
        root = Path(temporary)
        output = root / 'fixture.html'
        render_dashboard(fixture(), Path(__file__).resolve().parents[1] / 'templates', output)
        monitor = LiveMonitor(lambda: None, lambda: None, service_version='fixture-v1', page_version='template-v1')
        monitor.seed(output.read_bytes())
        with ForecastServer(('127.0.0.1', 0), monitor, public_prefix='/forecast/',
                            import_db=root / 'shared.sqlite3') as server:
            Thread(target=server.serve_forever, daemon=True).start()
            print(server.server_port, flush=True)
            try:
                sys.stdin.read()
            finally:
                server.shutdown()
