import type { ReactNode } from "react";
import { IChevR } from "../../shared/ui/icons";
import { Button, Surface } from "../../shared/ui/ios/controls";
import { tr } from "../../shared/i18n";

/** Keep the panel mounted so collapsing a group preserves drafts and async state. */
export default function SettingsSection({ title, icon, summary, open, onToggle, children }: {
  title: string;
  icon?: ReactNode;
  summary?: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const triggerId = `settings-title-${title}`;
  const panelId = `settings-panel-${title}`;
  return <section id={`settings-${title}`} aria-labelledby={triggerId} className="ios-settings-section">
    <Surface className="ios-setting-group ios-settings-frame" data-open={open}>
      <h2 aria-label={tr(title)}>
        <Button id={triggerId} aria-label={tr("{0}设置", tr(title))} aria-expanded={open} aria-controls={panelId}
          onClick={onToggle} className="ios-settings-trigger">
          {icon && <span className="ios-setting-icon" aria-hidden="true">{icon}</span>}
          <span className="ios-settings-heading">
            <span className="ios-settings-title">{tr(title)}</span>
            {summary && !open && <span className="ios-settings-summary">{summary}</span>}
          </span>
          <IChevR size={18} aria-hidden="true" className="ios-settings-chevron" />
        </Button>
      </h2>
      <div id={panelId} hidden={!open} className="ios-settings-panel">
        <div className="ios-settings-fields">{children}</div>
      </div>
    </Surface>
  </section>;
}
