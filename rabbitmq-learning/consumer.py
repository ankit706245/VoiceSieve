#!/usr/bin/env python3
"""
RabbitMQ Beginner Example - Consumer (संदेश प्राप्त करने वाला)
============================================================
Consumer का काम होता है RabbitMQ के Queue को सुनना (Listen करना),
जैसे ही कोई संदेश आए, उसे पढ़ना (Consume करना) और process करना।
"""

import sys
import pika

def main():
    # 1. RabbitMQ Server से Connection बनाएं
    credentials = pika.PlainCredentials('guest', 'guest')
    parameters = pika.ConnectionParameters(
        host='localhost',
        port=5672,
        virtual_host='/',
        credentials=credentials
    )

    connection = pika.BlockingConnection(parameters)
    channel = connection.channel()

    # 2. Queue declare करें (सुनिश्चित करने के लिए कि queue मौजूद है)
    queue_name = 'learning_queue'
    channel.queue_declare(queue=queue_name, durable=True)

    # 3. Message प्राप्त होने पर क्या करना है (Callback Function)
    def on_message_received(ch, method, properties, body):
        # Bytes को String में decode करके exact format में print करें
        message_content = body.decode('utf-8')
        print(f"Received: {message_content}")

        # RabbitMQ को बताएं कि message सफलतापूर्वक मिल गया है (Acknowledgment)
        ch.basic_ack(delivery_tag=method.delivery_tag)

        # अगर script को --once flag के साथ चलाया गया है, तो 1 message के बाद रुक जाएं
        if '--once' in sys.argv:
            channel.stop_consuming()

    # 4. Fair dispatch: एक बार में एक ही message process करें
    channel.basic_qos(prefetch_count=1)

    # 5. Consumer को Queue से जोड़े
    channel.basic_consume(
        queue=queue_name,
        on_message_callback=on_message_received
    )

    print(f"[*] Waiting for messages in '{queue_name}'. To exit press CTRL+C")
    try:
        channel.start_consuming()
    except KeyboardInterrupt:
        print("\n[*] Stopping consumer...")
        channel.stop_consuming()
    finally:
        connection.close()

if __name__ == '__main__':
    main()
