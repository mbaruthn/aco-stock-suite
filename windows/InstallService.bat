@echo off
set NSSM=C:\nssm\nssm.exe
set APP_DIR=C:\apps\aco-stock-suite
set NODE=C:\Program Files\nodejs\node.exe
set SVC=ACOStockSuite

%nssm% install %SVC% "%NODE%" "%APP_DIR%\server\index.js"
%nssm% set %SVC% AppDirectory "%APP_DIR%\server"
%nssm% start %SVC%
