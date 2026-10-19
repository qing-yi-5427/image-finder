import path from "node:path";
import type { TrayMenuState } from "./tray-actions.js";
interface WindowLike {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}
interface TrayLike {
  isDestroyed(): boolean;
  setToolTip(text: string): void;
  setContextMenu(menu: any): void;
  on(event: string, handler: () => void): any;
  destroy(): void;
}
export function trayIconPath(
  packaged: boolean,
  resources: string,
  appPath: string,
) {
  return packaged
    ? path.join(resources, "branding", "image-finder.ico")
    : path.join(appPath, "resources", "branding", "image-finder.ico");
}
/** The tray represents a running app; closing its window still follows normal quit. */
export class AppTray {
  private tray: TrayLike | undefined;
  private actions?: { navigate:(page:"tasks"|"settings")=>void;setPower:(enabled:boolean)=>Promise<void>;pause:()=>Promise<void>;error:(error:unknown)=>void };
  private state: TrayMenuState = {power:{enabled:false,active:false,error:null},canPause:false};
  constructor(
    private deps: {
      create: (icon: string) => TrayLike;
      menu: (items: any[]) => any;
      window: () => WindowLike | undefined;
      quit: () => void;
    },
  ) {}
  get exists() {
    return !!this.tray && !this.tray.isDestroyed();
  }
  showWindow = () => {
    const window = this.deps.window();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  configure(actions: NonNullable<AppTray["actions"]>) { this.actions=actions; this.refreshMenu(); }
  update(state:TrayMenuState, force=false) { const changed=JSON.stringify(this.state)!==JSON.stringify(state);this.state=state;if(changed||force)this.refreshMenu(); }
  private safely(action:()=>Promise<void>) { void action().catch(error=>this.actions?.error(error)); }
  private refreshMenu() {
    if(!this.exists)return;
    const extra = this.actions ? [
      {label:"后台任务",click:()=>{this.showWindow();this.actions!.navigate("tasks");}},
      {label:"设置",click:()=>{this.showWindow();this.actions!.navigate("settings");}},
      {type:"separator"},
      {label:this.state.power.enabled?"关闭任务防休眠":"开启任务防休眠",type:"normal",click:()=>{const enabled=!this.state.power.enabled;this.safely(()=>this.actions!.setPower(enabled));}},
      {label:"暂停正在运行的任务",enabled:this.state.canPause,click:()=>this.safely(()=>this.actions!.pause())},
    ] : [];
    this.tray!.setContextMenu(this.deps.menu([{label:"显示主窗口",click:this.showWindow},...extra,{type:"separator"},{label:"退出",click:()=>this.deps.quit()}]));
  }
  start(icon: string) {
    if (this.exists) return;
    const tray = this.deps.create(icon);
    this.tray = tray;
    tray.setToolTip("Image Finder");
    this.refreshMenu();
    tray.on("click", this.showWindow);
    tray.on("double-click", this.showWindow);
  }
  close() {
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy();
    this.tray = undefined;
  }
}
