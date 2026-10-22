package com.tvdeck.boot;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;

/// 配置存取：TVDeck 用 `adb shell content update --uri content://com.tvdeck.boot.config`
/// 写入，用 `content query` 回读。全部是 AOSP 标准 API，任何 Android 4.4+ 设备都支持。
public class ConfigProvider extends ContentProvider {
    public static final String AUTHORITY = "com.tvdeck.boot.config";
    public static final Uri URI = Uri.parse("content://" + AUTHORITY + "/config");
    public static final String PREFS = "tvdeck_boot";

    /// 列顺序即 MatrixCursor 的写入顺序，改这里要同步 BootReceiver
    static final String[] COLUMNS = {"enabled", "mode", "target", "delay_ms", "last_run", "last_result"};

    public static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        SharedPreferences p = prefs(getContext());
        MatrixCursor c = new MatrixCursor(COLUMNS);
        c.addRow(new Object[] {
            p.getBoolean("enabled", false) ? 1 : 0,
            p.getString("mode", "launch"),
            p.getString("target", ""),
            p.getInt("delay_ms", 8000),
            p.getLong("last_run", 0L),
            p.getString("last_result", "")
        });
        return c;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        apply(values);
        return uri;
    }

    /// content 工具的 update 可能带也可能不带 --where，两种都要能落盘
    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        apply(values);
        return 1;
    }

    private void apply(ContentValues values) {
        if (values == null || values.size() == 0) return;
        SharedPreferences.Editor e = prefs(getContext()).edit();
        if (values.containsKey("enabled")) e.putBoolean("enabled", truthy(values.getAsString("enabled")));
        if (values.containsKey("mode")) e.putString("mode", values.getAsString("mode"));
        if (values.containsKey("target")) e.putString("target", values.getAsString("target"));
        if (values.containsKey("delay_ms")) {
            Integer d = values.getAsInteger("delay_ms");
            e.putInt("delay_ms", d == null ? 8000 : d);
        }
        e.commit();
    }

    /// content 命令把 --bind x:i:1 也可能当字符串传进来，两种写法都认
    static boolean truthy(String s) {
        if (s == null) return false;
        String t = s.trim().toLowerCase();
        return t.equals("1") || t.equals("true") || t.equals("yes") || t.equals("on");
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        prefs(getContext()).edit().clear().commit();
        return 1;
    }

    @Override
    public String getType(Uri uri) {
        return "vnd.android.cursor.item/vnd.com.tvdeck.boot.config";
    }
}
