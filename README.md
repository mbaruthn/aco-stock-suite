# ACO Stock Suite

## Yapı
- server/ → Express tabanlı webhook servisi
- client/ → React/Vite yönetim paneli
- windows/ → Windows servis scriptleri
- README.md → Kurulum adımları

## Kurulum
1. `npm install`
2. `npm run build` (client için)
3. `.env` dosyasını doldur
4. `npm start`

## Servis Kurulum (Windows)
- `windows/InstallService.bat` yönetici ile çalıştır
- `windows/FirewallRules.bat` port açmak için kullan
