#!/bin/zsh
# 构建 TVDeck 开机自启 helper APK。只用 AOSP 标准 API，无第三方依赖。
# 依赖：JDK（javac）、Android SDK build-tools（aapt2/d8/zipalign/apksigner）、keytool
set -e

HERE=${0:a:h}
SDK=${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}
# 取 build-tools 里版本号最大的一个：老的 d8 在 JDK 21+ 上会 NPE
BT=$SDK/build-tools/$(ls "$SDK/build-tools" | sort -V | tail -1)
PLATFORM=$SDK/platforms/android-34/android.jar
OUT=$HERE/build

mkdir -p "$OUT/classes" "$OUT/dex"

echo "1/6 javac"
javac -source 8 -target 8 -nowarn -bootclasspath "$PLATFORM" -classpath "$PLATFORM" \
  -d "$OUT/classes" $(find "$HERE/src" -name '*.java')

echo "2/6 d8"
"$BT/d8" --release --min-api 21 --lib "$PLATFORM" --output "$OUT/dex" \
  $(find "$OUT/classes" -name '*.class')

echo "3/6 aapt2 compile res"
"$BT/aapt2" compile --dir "$HERE/res" -o "$OUT/res.zip"

echo "4/6 aapt2 link"
"$BT/aapt2" link -o "$OUT/unsigned.apk" \
  --manifest "$HERE/AndroidManifest.xml" \
  -I "$PLATFORM" \
  "$OUT/res.zip" \
  --min-sdk-version 21 --target-sdk-version 33 \
  --version-code 1 --version-name 1.0

echo "5/6 打包 dex"
(cd "$OUT/dex" && zip -q -X "$OUT/unsigned.apk" classes.dex)
"$BT/zipalign" -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

echo "6/6 签名"
KS=$HERE/tvdeck.keystore
if [ ! -f "$KS" ]; then
  keytool -genkeypair -v -keystore "$KS" -alias tvdeck -keyalg RSA -keysize 2048 \
    -validity 10950 -storepass tvdeck -keypass tvdeck \
    -dname "CN=TVDeck, OU=TVDeck, O=TVDeck, L=, S=, C=CN" >/dev/null 2>&1
fi
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:tvdeck --key-pass pass:tvdeck \
  --v1-signing-enabled true --v2-signing-enabled true \
  --out "$HERE/tvdeck-boot.apk" "$OUT/aligned.apk"

echo "完成: $HERE/tvdeck-boot.apk"
"$BT/apksigner" verify --print-certs "$HERE/tvdeck-boot.apk" | head -3
