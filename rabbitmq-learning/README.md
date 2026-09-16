# RabbitMQ Practical Beginner Guide (आसान हिंदी/Hinglish गाइड)

नमस्ते अंकित! यह डायरेक्टरी RabbitMQ को बिल्कुल बेसिक से समझने और प्रैक्टिकल टेस्ट करने के लिए बनाई गई है। यह पूरी तरह से स्वतंत्र (isolated) है और आपके मुख्य Vaani प्रोजेक्ट को बिल्कुल टच नहीं करती।

---

## 1. आसान भाषा में: RabbitMQ क्या है?

सोचिए एक डाकघर (Post Office) की तरह:
1. **Producer (संदेश भेजने वाला):** आप एक चिट्ठी लिखते हैं और लेटर बॉक्स में डाल देते हैं।
2. **RabbitMQ (डाकघर & लेटर बॉक्स):** यह संदेश को सुरक्षित रखता है और सही पते पर पहुँचाता है।
3. **Queue (कतार / लाइन):** यह वह बक्सा (Box) है जहाँ संदेश कतार में एक के बाद एक इंतज़ार करते हैं। (First In, First Out - FIFO)
4. **Consumer (संदेश पढ़ने वाला):** डाकिया या प्राप्तकर्ता उस बक्से से चिट्ठी निकालता है और पढ़ता है।

---

## 2. आर्किटेक्चर फ्लो (Architecture Flow)

```
[ Producer: producer.py ]
          │
          │ 1. sends "Hello Ankit" (Publish)
          ▼
┌───────────────────────────────────────────────┐
│              RabbitMQ Server                  │
│             (localhost:5672)                  │
│                                               │
│    Exchange (Default direct exchange)         │
│          │                                    │
│          ▼                                    │
│    Queue: [ learning_queue ]                  │
│    [ "Hello Ankit" ] (Waiting in queue)       │
└──────────────────────┬────────────────────────┘
                       │
                       │ 2. delivers message (Consume)
                       ▼
            [ Consumer: consumer.py ]
             Prints: "Received: Hello Ankit"
             Sends Ack (Acknowledgment) back to RabbitMQ
```

### इन 4 चीज़ों को समझें:
1. **Producer:** वह प्रोग्राम या कोड जो कोई काम या डेटा भेजता है। (उदाहरण: `producer.py`)
2. **RabbitMQ (Message Broker):** एक बिचौलिया (Middleman) जो संदेशों को सुरक्षित रखता है जब तक कोई उसे उठा न ले।
3. **Queue:** RabbitMQ के अंदर का एक बफर/कतार जिसमें संदेश तब तक रहते हैं जब तक Consumer उन्हें process न कर ले।
4. **Consumer:** वह प्रोग्राम जो Queue से संदेश उठाता है और उस पर काम करता है। (उदाहरण: `consumer.py`)

---

## 3. फाइल्स की सूची (Files Created)

```
rabbitmq-learning/
├── requirements.txt   # केवल pika लाइब्रेरी की ज़रूरत
├── producer.py        # RabbitMQ से कनेक्ट होकर "Hello Ankit" भेजता है
├── consumer.py        # Queue को सुनकर "Received: Hello Ankit" प्रिंट करता है
└── README.md          # यह गाइड
```

---

## 4. प्रैक्टिकल टेस्ट कैसे चलाएं (How to Run)

### स्टेप 1: डायरेक्टरी में जाएं
```bash
cd "/Users/ankitsharma/Desktop/ai voice agent /rabbitmq-learning"
```

### स्टेप 2: डिपेंडेंसी इंस्टॉल करें (यदि पहले से नहीं है)
```bash
pip3 install -r requirements.txt
```

### स्टेप 3 (ऑप्शन A): पहले Producer चलाएं, फिर Consumer चलाएं
RabbitMQ का सबसे बड़ा फायदा यही है कि अगर Consumer बंद भी है, तो संदेश गायब नहीं होता, Queue में सुरक्षित रहता है!

1. संदेश भेजें:
```bash
python3 producer.py
```
*आउटपुट:*
```
[*] Connecting to RabbitMQ at localhost:5672...
[✓] Success: Message sent to RabbitMQ queue 'learning_queue' -> 'Hello Ankit'
```

2. संदेश प्राप्त करें:
```bash
python3 consumer.py --once
```
*आउटपुट:*
```
[*] Waiting for messages in 'learning_queue'. To exit press CTRL+C
Received: Hello Ankit
```

---

### स्टेप 3 (ऑप्शन B): दो अलग-अलग टर्मिनल में लाइव टेस्ट (Real-time Streaming)
1. **टर्मिनल 1** में Consumer को लगातार चालू रखें:
   ```bash
   python3 consumer.py
   ```
   (यह इंतज़ार करेगा `Waiting for messages in 'learning_queue'...`)

2. **टर्मिनल 2** में Producer को चलाएं:
   ```bash
   python3 producer.py
   ```

3. टर्मिनल 1 में तुरंत दिखेगा:
   ```
   Received: Hello Ankit
   ```

---

## 5. RabbitMQ Management UI (वेब डैशबोर्ड)

RabbitMQ एक खूबसूरत विजुअल डैशबोर्ड देता है:
* **URL:** [http://localhost:15672](http://localhost:15672)
* **Username:** `guest`
* **Password:** `guest`

यहाँ आप लाइव देख सकते हैं:
* **Queues टैब:** `learning_queue` दिखेगी, कितने मैसेज आए और गए।
* **Connections / Channels:** एक्टिव Python कनेक्शन्स दिखेंगे।

---

## 6. मुख्य अवधारणाएं (Key Concepts for Beginners)

* **Ack (Acknowledgment):** Consumer जब मैसेज पढ़ लेता है, तो वह RabbitMQ को कहता है *"हाँ मुझे मिल गया, अब इसे Queue से हटा दो"* (`ch.basic_ack()`)। अगर Consumer मैसेज प्रोसेस करते समय क्रैश हो जाए, तो मैसेज खोता नहीं है, RabbitMQ उसे दूसरे Consumer को दे देता है।
* **Durable Queue (`durable=True`):** अगर RabbitMQ सर्वर रीस्टार्ट भी हो जाए, तब भी आपकी Queue और Messages गायब नहीं होते।
