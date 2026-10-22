package com.tvdeck.boot;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;

import java.util.List;

/// 开机后按配置拉起目标应用。目标是厂商无关的：只查 PackageManager，
/// 不碰任何厂商私有服务，所以在康佳/小米/索尼/海信上都走同一条路径。
public class BootReceiver extends BroadcastReceiver {

    /// 广播和无障碍服务两条通路共用同一套「按配置启动」逻辑。
    /// onDone 允许为空，只有广播通路需要 finish()。
    static boolean launchConfigured(final Context ctx, final Runnable onDone) {
        final SharedPreferences p = ConfigProvider.prefs(ctx);
        if (!p.getBoolean("enabled", false)) return false;
        final String mode = p.getString("mode", "launch");
        final String target = p.getString("target", "");
        if (mode == null || target == null || target.isEmpty()) return false;
        if (!mode.equals("launch") && !mode.equals("launch_if_home")) return false;
        new Thread(new Runnable() {
            @Override
            public void run() {
                String result;
                try {
                    int delay = p.getInt("delay_ms", 8000);
                    if (delay < 0) delay = 0;
                    if (delay > 180000) delay = 180000;
                    Thread.sleep(delay);
                    result = launch(ctx, target);
                } catch (Throwable t) {
                    result = "error:" + t.getClass().getSimpleName();
                }
                p.edit()
                    .putLong("last_run", System.currentTimeMillis())
                    .putString("last_result", result)
                    .commit();
                if (onDone != null) onDone.run();
            }
        }).start();
        return true;
    }

    @Override
    public void onReceive(final Context ctx, Intent intent) {
        /// goAsync：onReceive 返回后广播进程仍会被保留，延迟结束才 finish
        final PendingResult pending = goAsync();
        if (!launchConfigured(ctx, new Runnable() {
            @Override
            public void run() {
                pending.finish();
            }
        })) pending.finish();
    }

    /// 优先 getLaunchIntentForPackage；返回 null 的（部分大屏应用不注册 LAUNCHER）
    /// 再依次退到 LEANBACK_LAUNCHER / LAUNCHER 查询，自己拼显式 Intent
    static String launch(Context ctx, String pkg) {
        PackageManager pm = ctx.getPackageManager();
        Intent i = null;
        try {
            i = pm.getLaunchIntentForPackage(pkg);
        } catch (Throwable ignored) {
        }
        if (i == null) i = resolve(ctx, pkg, Intent.CATEGORY_LEANBACK_LAUNCHER);
        if (i == null) i = resolve(ctx, pkg, Intent.CATEGORY_LAUNCHER);
        if (i == null) i = resolve(ctx, pkg, Intent.CATEGORY_HOME);
        /// 最后一道兜底：目标可以写成显式组件 "pkg/Cls"。
        /// Android 11+ 的包可见性过滤下，queryIntentActivities 对没在 queries 里
        /// 声明过的应用返回空，这时只有显式组件能直接构造 Intent。
        /// 部分大屏设备的厂商桌面/直播应用常有这种情况。
        if (i == null && pkg.indexOf('/') > 0) {
            try {
                i = Intent.makeMainActivity(android.content.ComponentName.unflattenFromString(pkg));
            } catch (Throwable ignored) {
            }
        }
        if (i == null) return "no_launchable_activity";
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            ctx.startActivity(i);
            return "started:" + i.getComponent().flattenToShortString();
        } catch (Throwable t) {
            return "start_failed:" + t.getClass().getSimpleName();
        }
    }

    static Intent resolve(Context ctx, String pkg, String category) {
        try {
            Intent q = new Intent(Intent.ACTION_MAIN).addCategory(category).setPackage(pkg);
            List<ResolveInfo> ris = ctx.getPackageManager().queryIntentActivities(q, 0);
            if (ris == null || ris.isEmpty()) return null;
            ActivityInfo ai = ris.get(0).activityInfo;
            return new Intent(Intent.ACTION_MAIN).setClassName(ai.packageName, ai.name);
        } catch (Throwable t) {
            return null;
        }
    }
}
