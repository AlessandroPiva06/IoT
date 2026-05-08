// ============================================================
//  SmartStation — Firmware ESP32
//  Componenti: BMP280+AHT20 · OLED SSD1306 · WiFi · MQTT
//  Pinout:
//    SDA → GPIO 21
//    SCL → GPIO 22
//    (display e sensore condividono lo stesso bus I2C)
// ============================================================

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <Adafruit_AHTX0.h>
#include <Adafruit_BMP280.h>
#include <Adafruit_SSD1306.h>

// ---------- CONFIGURAZIONE ----------
const char* WIFI_SSID     = "NomeRete";
const char* WIFI_PASSWORD = "password";
const char* MQTT_SERVER   = "192.168.1.100";   // IP del PC con il server
const int   MQTT_PORT     = 1883;

// ---------- TOPIC MQTT ----------
const char* TOPIC_DATI = "stazione/dati";   // ESP32 pubblica qui
const char* TOPIC_CMD  = "stazione/cmd";    // ESP32 ascolta qui

// ---------- OGGETTI ----------
Adafruit_AHTX0   aht;
Adafruit_BMP280  bmp;
Adafruit_SSD1306 display(128, 64, &Wire, -1);

WiFiClient   wifiClient;
PubSubClient mqtt(wifiClient);

// ============================================================
//  SETUP
// ============================================================
void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);

  // --- Display OLED ---
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("[ERR] OLED non trovato");
  }
  mostraMessaggio("Avvio...");

  // --- Sensore AHT20 ---
  if (!aht.begin()) {
    Serial.println("[ERR] AHT20 non trovato");
  }

  // --- Sensore BMP280 (indirizzo 0x76 o 0x77 a seconda del modulo) ---
  if (!bmp.begin(0x76)) {
    Serial.println("[ERR] BMP280 non trovato");
  }

  // --- WiFi ---
  collegaWiFi();

  // --- MQTT ---
  mqtt.setServer(MQTT_SERVER, MQTT_PORT);
  mqtt.setCallback(riceviComando);
  collegaMQTT();

  Serial.println("[OK] Sistema pronto");
}

// ============================================================
//  LOOP
// ============================================================
void loop() {
  if (!mqtt.connected()) collegaMQTT();
  mqtt.loop();

  // Leggi sensori
  sensors_event_t evTemp, evUmid;
  aht.getEvent(&evUmid, &evTemp);

  float temperatura = evTemp.temperature;
  float umidita     = evUmid.relative_humidity;
  float pressione   = bmp.readPressure() / 100.0;  // Pa → hPa

  // Aggiorna display
  aggiornaDisplay(temperatura, umidita, pressione);

  // Pubblica su MQTT
  StaticJsonDocument<128> doc;
  doc["temp"]     = round(temperatura * 10) / 10.0;
  doc["umidita"]  = round(umidita * 10) / 10.0;
  doc["pressione"]= round(pressione * 10) / 10.0;
  doc["uptime"]   = millis() / 1000;

  char buf[128];
  serializeJson(doc, buf);
  mqtt.publish(TOPIC_DATI, buf);
  Serial.printf("[MQTT] Pubblicato: %s\n", buf);

  delay(5000);  // pubblica ogni 5 secondi
}

// ============================================================
//  DISPLAY OLED
// ============================================================
void aggiornaDisplay(float t, float h, float p) {
  display.clearDisplay();
  display.setTextColor(WHITE);
  display.setTextSize(1);

  display.setCursor(0, 0);  display.printf("Temp:     %.1f C",  t);
  display.setCursor(0, 18); display.printf("Umidita:  %.0f %%", h);
  display.setCursor(0, 36); display.printf("Pressione:%.1f hPa", p);

  String stato = WiFi.isConnected() ? "WiFi OK" : "WiFi NO";
  display.setCursor(0, 54); display.print(stato);

  display.display();
}

void mostraMessaggio(String msg) {
  display.clearDisplay();
  display.setTextColor(WHITE);
  display.setTextSize(1);
  display.setCursor(10, 28);
  display.print(msg);
  display.display();
}

// ============================================================
//  CALLBACK MQTT — ricezione comandi
// ============================================================
void riceviComando(char* topic, byte* payload, unsigned int length) {
  String msg = "";
  for (unsigned int i = 0; i < length; i++) msg += (char)payload[i];
  Serial.printf("[CMD] Ricevuto: %s\n", msg.c_str());

  // Esempio: {"cmd":"reboot"} oppure {"cmd":"info"}
  StaticJsonDocument<64> doc;
  if (deserializeJson(doc, msg) != DeserializationError::Ok) return;

  const char* cmd = doc["cmd"];
  if (!cmd) return;

  if (strcmp(cmd, "reboot") == 0) {
    mostraMessaggio("Riavvio...");
    delay(1000);
    ESP.restart();
  } else if (strcmp(cmd, "info") == 0) {
    Serial.printf("Heap libero: %d bytes\n", ESP.getFreeHeap());
    Serial.printf("RSSI WiFi: %d dBm\n", WiFi.RSSI());
  }
}

// ============================================================
//  CONNESSIONI
// ============================================================
void collegaWiFi() {
  Serial.printf("[WiFi] Connessione a %s", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.printf("\n[WiFi] Connesso — IP: %s\n", WiFi.localIP().toString().c_str());
}

void collegaMQTT() {
  while (!mqtt.connected()) {
    Serial.print("[MQTT] Connessione...");
    if (mqtt.connect("SmartStation_ESP32")) {
      Serial.println(" OK");
      mqtt.subscribe(TOPIC_CMD);
    } else {
      Serial.printf(" Fallito (rc=%d). Riprovo tra 5s\n", mqtt.state());
      delay(5000);
    }
  }
}
