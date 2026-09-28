python3 scripts/dev.py --api-port 7102 --media-port 7103 --web-port 3102
python3 -m unittest discover -s tests -p 'test_*.py'
pnpm --dir web-app build
pnpm --dir web-app test
pnpm --dir sdk/typescript test
python3 -m unittest discover -s sdk/python/tests -p 'test_*.py'
python3 scripts/check_contracts.py
python3 scripts/replay_capture.py --fixture tests/fixtures/day.json --accelerated
