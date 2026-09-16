#!/usr/bin/env python3
"""
RabbitMQ Beginner Example - Producer (संदेश भेजने वाला)
======================================================
Producer का काम होता है संदेश (Message) तैयार करना और
उसे RabbitMQ के Queue में डालना (Publish करना)।
"""

import pika

def main():
    # 1. RabbitMQ Server से Connection बनाएं
    # Default port: 5672, Default user/pass: guest/guest
    credentials = pika.PlainCredentials('guest', 'guest')
    parameters = pika.ConnectionParameters(
        host='localhost',
        port=5672,
        virtual_host='/',
        credentials=credentials
    )
    
    print("[*] Connecting to RabbitMQ at localhost:5672...")
    connection = pika.BlockingConnection(parameters)
    channel = connection.channel()

    # 2. Queue (कतार) declare करें
    # durable=True का मतलब है कि अगर RabbitMQ restart भी हो जाए तो queue बनी रहेगी
    queue_name = 'learning_queue'
    channel.queue_declare(queue=queue_name, durable=True)

    # 3. Message भेजें (Publish)
    message_text = "Hello Ankit"
    channel.basic_publish(
        exchange='',                       # Default exchange (direct to queue by name)
        routing_key=queue_name,            # Queue का नाम
        body=message_text,                 # संदेश
        properties=pika.BasicProperties(
            delivery_mode=2,               # Make message persistent on disk
        )
    )

    # 4. Success message print करें
    print(f"[✓] Success: Message sent to RabbitMQ queue '{queue_name}' -> '{message_text}'")

    # 5. Connection बंद करें
    connection.close()

if __name__ == '__main__':
    main()
