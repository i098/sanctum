npm run dev -- --api-port 7102 --web-port 3102
npm run check:app
npm run build --workspace server
npm run build --workspace web-app
npm run build --workspace sdk/typescript
npm run test --workspace server
npm run test --workspace web-app
npm run test --workspace sdk/typescript
python3 -m unittest discover -s sdk/python/tests -p 'test_*.py'
node scripts/check-contracts.ts
node scripts/replay-capture.ts --fixture server/tests/fixtures/day.json --accelerated
