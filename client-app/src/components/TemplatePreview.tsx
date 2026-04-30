export interface TemplatePreviewNode {
  id: string;
  position: { x: number; y: number };
  data?: Record<string, unknown>;
  nodeType?: string;
}

export interface TemplatePreviewEdge {
  id?: string;
  source: string;
  target: string;
  label?: string;
}

const NODE_HANDLE_COLORS: Record<string, string> = {
  greeting: '#10b981',
  askQuestion: '#3b82f6',
  confirmInfo: '#6366f1',
  condition: '#f59e0b',
  routeDecision: '#f97316',
  createTicket: '#a855f7',
  createContact: '#ec4899',
  scheduleAppt: '#06b6d4',
  sendSms: '#14b8a6',
  dispatchJob: '#f43f5e',
};

const DEFAULT_HANDLE_COLOR = '#6b7280';

const NODE_W = 140;
const NODE_H = 56;

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
}

export interface TemplatePreviewProps {
  nodes: TemplatePreviewNode[];
  edges: TemplatePreviewEdge[];
  width: number;
  height: number;
  showLabels?: boolean;
  ariaLabel?: string;
}

/**
 * Auto-generated mini visualization of a template's node graph. Node labels
 * are rendered when `showLabels` is true and the scaled node box is tall
 * enough to fit text. Edge labels are rendered the same way at the midpoint
 * of each edge so reviewers can see how a branching template routes.
 */
export function TemplatePreview({
  nodes,
  edges,
  width,
  height,
  showLabels = false,
  ariaLabel,
}: TemplatePreviewProps) {
  if (nodes.length === 0) {
    return <svg width={width} height={height} aria-hidden="true" />;
  }
  const padding = 12;
  const minX = Math.min(...nodes.map((n) => n.position.x));
  const minY = Math.min(...nodes.map((n) => n.position.y));
  const maxX = Math.max(...nodes.map((n) => n.position.x + NODE_W));
  const maxY = Math.max(...nodes.map((n) => n.position.y + NODE_H));
  const graphW = maxX - minX;
  const graphH = maxY - minY;
  const innerW = Math.max(width - padding * 2, 1);
  const innerH = Math.max(height - padding * 2, 1);
  const scale = Math.min(innerW / graphW, innerH / graphH);
  const offX = (width - graphW * scale) / 2 - minX * scale;
  const offY = (height - graphH * scale) / 2 - minY * scale;

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const colorOf = (n: TemplatePreviewNode) => {
    const nt = (n.nodeType ?? (n.data?.nodeType as string) ?? '') as string;
    return NODE_HANDLE_COLORS[nt] ?? DEFAULT_HANDLE_COLOR;
  };

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
      className="block"
    >
      <g>
        {edges.map((e, i) => {
          const s = nodeMap.get(e.source);
          const t = nodeMap.get(e.target);
          if (!s || !t) return null;
          const x1 = (s.position.x + NODE_W / 2) * scale + offX;
          const y1 = (s.position.y + NODE_H) * scale + offY;
          const x2 = (t.position.x + NODE_W / 2) * scale + offX;
          const y2 = t.position.y * scale + offY;
          const midX = (x1 + x2) / 2;
          const midY = (y1 + y2) / 2;
          return (
            <g key={e.id ?? `${e.source}-${e.target}-${i}`}>
              <path
                d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
                fill="none"
                stroke="currentColor"
                strokeWidth={1}
                opacity={0.85}
                className="text-border"
              />
              {showLabels && e.label && (
                <text
                  x={midX}
                  y={midY}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={9}
                  className="fill-text-secondary font-medium"
                  data-edge-label="true"
                  data-edge-id={e.id ?? `${e.source}-${e.target}-${i}`}
                >
                  {truncate(e.label, 16)}
                </text>
              )}
            </g>
          );
        })}
        {nodes.map((n) => {
          const x = n.position.x * scale + offX;
          const y = n.position.y * scale + offY;
          const w = NODE_W * scale;
          const h = NODE_H * scale;
          const color = colorOf(n);
          const label = n.data?.label as string | undefined;
          return (
            <g key={n.id}>
              <rect
                x={x}
                y={y}
                width={w}
                height={h}
                rx={Math.min(4, h / 4)}
                fill={color}
                fillOpacity={0.18}
                stroke={color}
                strokeWidth={1}
              />
              {showLabels && label && h > 14 && (
                <text
                  x={x + w / 2}
                  y={y + h / 2 + 3}
                  textAnchor="middle"
                  fontSize={Math.min(9, h / 3)}
                  fill={color}
                  className="font-medium"
                  data-node-label="true"
                  data-node-id={n.id}
                >
                  {truncate(label, 14)}
                </text>
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}
