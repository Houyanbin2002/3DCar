import { StrictMode, useMemo, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { VoicePanel } from '../../src/ui/VoicePanel';
import { PART_LABELS } from '../../src/voice/parseCommand';
import { createBrowserSpeechInput, createBrowserSpeechOutput } from '../../src/voice/speechIO';
import type { ControlClient } from '../../src/voice/controlClient';
import { WINDOW_IDS } from '../../src/contracts/vehicle';
import type { PartSnapshot } from '../../src/contracts/vehicle';
import type { PartId } from '../../src/contracts/vehicle';
import { createSimulatedVehicle, SimulatedInput } from './mockVehicle';
import './dev.css';

const vehicle = createSimulatedVehicle();
const simulatedInput = new SimulatedInput();
const simulatedOutput = { speak: async () => {} };
const simulatedControl: ControlClient = async ({ text, context, history }) => {
  if (history) return { toolCalls: [], reply: '已核对本轮执行结果。' };
  if (!/闷|热|透气/u.test(text)) return { toolCalls: [], reply: '请补充动作和具体部件，例如打开左前窗。' };
  const parts = context.set_vehicle_part as Record<string, PartSnapshot>;
  const partId = WINDOW_IDS.find((id) => !parts[id].open && !parts[id].moving);
  return partId
    ? { toolCalls: [{ id: 'simulated-call', name: 'set_vehicle_part', arguments: { partId, open: true } }], reply: '' }
    : { toolCalls: [], reply: '车窗已经降下了。' };
};

function Demo() {
  const [live, setLive] = useState(false);
  const [realModel, setRealModel] = useState(false);
  const [text, setText] = useState('小满同学，打开左前门，再打开后备箱');
  const input = useMemo(() => live ? createBrowserSpeechInput() : simulatedInput, [live]);
  const output = useMemo(() => live ? createBrowserSpeechOutput() : simulatedOutput, [live]);
  const snapshot = useSyncExternalStore(vehicle.subscribe, vehicle.getSnapshot);
  return (
    <main className="voice-demo">
      <section className="voice-demo__tools">
        <p className="voice-demo__eyebrow">独立验证 · codex/voice-control</p>
        <h1>小满语音控车</h1>
        <p>本页用模拟车辆记录动作，供语音模块独立验收。先开启右侧语音，再输入一次识别结果。</p>
        <div className="voice-demo__settings">
          <label><input type="checkbox" checked={live} onChange={(event) => setLive(event.target.checked)} />真实麦克风</label>
          <label><input type="checkbox" checked={realModel} onChange={(event) => setRealModel(event.target.checked)} />真实模型接口</label>
        </div>
        <p className="voice-demo__note">默认使用模拟识别与模拟模型。真实模型读取 VITE_INTENT_API_URL，麦克风使用浏览器授权。</p>
        <form onSubmit={(event) => { event.preventDefault(); simulatedInput.say(text); }}>
          <label htmlFor="transcript">模拟识别结果</label>
          <textarea id="transcript" value={text} onChange={(event) => setText(event.target.value)} rows={3} disabled={live} />
          <button disabled={live} type="submit">发送这句话</button>
        </form>
        <div className="voice-demo__examples">
          {['小满同学', '小满同学，打开前备箱和后备箱', '小满同学，车里有点闷热', '需要', '不用'].map((sample) => (
            <button type="button" key={sample} disabled={live} onClick={() => simulatedInput.say(sample)}>{sample}</button>
          ))}
        </div>
        <h2>模拟车辆当前状态</h2>
        <ul className="voice-demo__parts">
          {Object.entries(snapshot.parts).map(([id, part]) => <li key={id}>
            <span>{PART_LABELS[id as PartId]}</span><strong>{part.open ? '已打开' : '已关闭'}</strong>
          </li>)}
          <li><span>引擎</span><strong>{snapshot.engineRunning ? '运行中' : '已熄火'}</strong></li>
        </ul>
      </section>
      <VoicePanel controller={vehicle} input={input} output={output} controlClient={realModel ? undefined : simulatedControl} />
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing voice demo root');
createRoot(root).render(<StrictMode><Demo /></StrictMode>);
