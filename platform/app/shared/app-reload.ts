export type ReloadWorkItem = {
  id: string;
  label: string;
  detail: string;
  page?: string;
  recordId?: string;
};
export type AppReloadReceipt = {
  reloading: boolean;
  pid: number;
  waiting?: boolean;
};
export type AppReloadStatus = AppReloadReceipt & {
  remaining: ReloadWorkItem[];
};
export type AppHealth = {
  status: string;
  pid: number;
  reloading?: boolean;
  reload?: AppReloadStatus;
};
