
export type Go = (page: string, id?: string) => void;
export type Mutate = (path: string, body: any, method?: string) => Promise<any>;
export type NoticeMessage = {
  text: string;
  links?: { label: string; page: string; id?: string; detail?: string }[];
  suffix?: string;
  more?: number;
  tone?: "success" | "attention";
};
export type Notify = (message: string, content?: Omit<NoticeMessage, "text">) => void;
