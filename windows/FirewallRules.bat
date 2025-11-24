@echo off
set PORT=8080
netsh advfirewall firewall add rule name="ACOStockSuite" dir=in action=allow protocol=TCP localport=%PORT%
