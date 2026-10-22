package com.tvdeck.boot;

import android.accessibilityservice.AccessibilityService;
import android.content.Intent;
import android.view.accessibility.AccessibilityEvent;

/// 兜底通路：无障碍服务是 Android 明确的 BAL 豁免项之一，个别 ROM 把
/// 悬浮窗豁免裁掉后还能靠它把应用拉起来。服务本身不读任何屏幕内容。
public class BootAccessibilityService extends AccessibilityService {
    static volatile BootAccessibilityService instance;

    @Override
    protected void onServiceConnected() {
        instance = this;
        /// 服务在开机时由系统拉起，这里补一次启动，覆盖「悬浮窗豁免不可用」的情况
        BootReceiver.launchConfigured(getApplicationContext(), null);
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
    }

    @Override
    public void onInterrupt() {
    }

    @Override
    public boolean onUnbind(Intent intent) {
        instance = null;
        return super.onUnbind(intent);
    }
}
