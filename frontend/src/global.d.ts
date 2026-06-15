declare var pendo: {
  track: (event: string, props?: Record<string, unknown>) => void;
  trackAgent: (eventType: string, metadata: object) => void;
  initialize: (options: Record<string, unknown>) => void;
  [key: string]: any;
};
