import { useVoiceControl } from '../voice/useVoiceControl';
import type { VoiceControlOptions, VoicePhase } from '../voice/VoiceControl';
import './voice-panel.css';

const phaseLabels: Record<VoicePhase, string> = {
  off: '未开启', starting: '启动中', waiting: '等待唤醒', listening: '聆听指令',
  thinking: '正在理解', speaking: '播报建议', confirming: '等待确认', executing: '执行中',
  error: '语音异常', unsupported: '暂不支持',
};

export function VoicePanel(props: VoiceControlOptions) {
  const { snapshot, start, stop, confirm, cancel } = useVoiceControl(props);
  const busy = ['listening', 'thinking', 'speaking', 'executing'].includes(snapshot.phase);

  return (
    <section className="voice-panel" aria-label="小满语音控车" data-phase={snapshot.phase}>
      <div className="voice-panel__header">
        <svg className="voice-panel__mic" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="9" y="2" width="6" height="12" rx="3" />
          <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
        </svg>
        <div className="voice-panel__title">
          <h2>语音控车</h2>
          <span>{phaseLabels[snapshot.phase]}</span>
        </div>
        <button type="button" className="voice-panel__toggle"
          disabled={snapshot.phase === 'unsupported'} onClick={snapshot.enabled ? stop : start}>
          {snapshot.enabled ? '关闭语音' : '开启语音'}
        </button>
      </div>
      <p className="voice-panel__message" role="status" aria-live="polite">{snapshot.message}</p>
      {snapshot.transcript && <p className="voice-panel__transcript">听到「{snapshot.transcript}」</p>}
      {snapshot.feedback.length > 0 && (
        <ul className="voice-panel__feedback" aria-label="本轮处理结果">
          {snapshot.feedback.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}
        </ul>
      )}
      {snapshot.phase === 'confirming' && (
        <div className="voice-panel__actions">
          <button type="button" onClick={() => confirm(true)}>需要</button>
          <button type="button" onClick={() => confirm(false)}>不用</button>
        </div>
      )}
      {busy && <button type="button" className="voice-panel__cancel" onClick={cancel}>取消本轮</button>}
      <p className="voice-panel__example">“小满同学，打开左前车窗”</p>
      <small className="voice-panel__privacy">智能建议需联网，相关识别文字会发送到模型服务。</small>
    </section>
  );
}
