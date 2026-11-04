import './demo-video-panel.css';

function demoVideoUrl(): string | null {
  const configured = import.meta.env.VITE_DEMO_VIDEO_URL?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured, new URL(import.meta.env.BASE_URL, window.location.origin));
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

export function DemoVideoPanel() {
  const url = demoVideoUrl();
  const inline = url && /\.(mp4|webm|ogg)(?:[?#]|$)/iu.test(url);
  return (
    <section className="demo-video-panel" aria-label="语音交互演示视频" data-video-state={url ? 'available' : 'pending'}>
      <div className="demo-video-panel__heading">
        <h2>语音交互演示</h2>
        <span>本地完整版</span>
      </div>
      <p>在线体验旋转、缩放与点击控车，完整语音交互将在视频中展示。</p>
      {inline ? (
        <video className="demo-video-panel__video" src={url} controls preload="metadata" playsInline>
          <a href={url}>观看语音演示视频</a>
        </video>
      ) : url ? (
        <a className="demo-video-panel__link" href={url} target="_blank" rel="noopener noreferrer">
          <span aria-hidden="true">▶</span> 观看演示视频 ↗
        </a>
      ) : (
        <div className="demo-video-panel__placeholder">
          <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <circle cx="16" cy="16" r="13" />
            <path d="m13 10 9 6-9 6V10Z" />
          </svg>
          <div><strong>演示视频待上传</strong><span>唤醒控车 · 连续对话 · 智能调整</span></div>
        </div>
      )}
    </section>
  );
}
