# fichier: etape1_fondamentaux/simulation_ddos_simple.py
"""
ÉTAPE 1: Comprendre une attaque DDoS simple
Ce script simule un serveur et une attaque basique
"""

import time
import random
from dataclasses import dataclass
from typing import List
from datetime import datetime

# ============================================================
# PARTIE 1: Définir ce qu'est une requête
# ============================================================

@dataclass
class Request:
    """Représente une requête réseau"""
    source_ip: str          # D'où vient la requête
    timestamp: float        # Quand elle arrive
    request_type: str       # Type: "normal" ou "attack"
    size_bytes: int         # Taille en octets
    
    def __str__(self):
        return f"[{self.request_type.upper()}] {self.source_ip} - {self.size_bytes} bytes"


# ============================================================
# PARTIE 2: Simuler un serveur simple
# ============================================================

class SimpleServer:
    """
    Un serveur basique avec une capacité limitée
    
    Concepts clés:
    - capacity_rps: Requêtes par seconde que le serveur peut traiter
    - Si on dépasse cette capacité → serveur surchargé
    """
    
    def __init__(self, name: str, capacity_rps: int):
        self.name = name
        self.capacity_rps = capacity_rps  # Requêtes Par Seconde max
        self.current_requests: List[Request] = []
        self.processed_count = 0
        self.dropped_count = 0
        self.is_overwhelmed = False
    
    def receive_request(self, request: Request) -> bool:
        """
        Reçoit une requête
        Retourne True si traitée, False si rejetée
        """
        # Compter les requêtes dans la dernière seconde
        current_time = time.time()
        recent_requests = [
            r for r in self.current_requests 
            if current_time - r.timestamp < 1.0
        ]
        
        # Vérifier si on peut traiter
        if len(recent_requests) < self.capacity_rps:
            self.current_requests.append(request)
            self.processed_count += 1
            return True
        else:
            self.dropped_count += 1
            self.is_overwhelmed = True
            return False
    
    def get_status(self) -> dict:
        """Retourne l'état du serveur"""
        current_time = time.time()
        recent = len([r for r in self.current_requests if current_time - r.timestamp < 1.0])
        
        return {
            "name": self.name,
            "capacity": self.capacity_rps,
            "current_load": recent,
            "load_percentage": (recent / self.capacity_rps) * 100,
            "processed": self.processed_count,
            "dropped": self.dropped_count,
            "status": "OVERWHELMED 🔴" if self.is_overwhelmed else "OK 🟢"
        }


# ============================================================
# PARTIE 3: Générateur de trafic (normal et attaque)
# ============================================================

class TrafficGenerator:
    """Génère du trafic réseau simulé"""
    
    @staticmethod
    def generate_normal_traffic(count: int) -> List[Request]:
        """Génère du trafic utilisateur normal"""
        requests = []
        for i in range(count):
            req = Request(
                source_ip=f"192.168.1.{random.randint(1, 254)}",
                timestamp=time.time() + (i * 0.1),  # Espacé dans le temps
                request_type="normal",
                size_bytes=random.randint(500, 2000)
            )
            requests.append(req)
        return requests
    
    @staticmethod
    def generate_ddos_attack(count: int, attack_type: str = "UDP_FLOOD") -> List[Request]:
        """
        Génère une attaque DDoS
        
        Caractéristiques d'une attaque:
        - Beaucoup de requêtes en très peu de temps
        - Souvent depuis des IPs aléatoires (spoofées)
        - Gros volumes de données
        """
        requests = []
        for i in range(count):
            req = Request(
                # IPs aléatoires (simulant un botnet)
                source_ip=f"{random.randint(1,255)}.{random.randint(1,255)}.{random.randint(1,255)}.{random.randint(1,255)}",
                timestamp=time.time() + (i * 0.001),  # Très rapproché!
                request_type="attack",
                size_bytes=random.randint(10000, 65000)  # Gros paquets
            )
            requests.append(req)
        return requests


# ============================================================
# PARTIE 4: Démonstration
# ============================================================

def demo_normal_traffic():
    """Montre comment un serveur gère le trafic normal"""
    print("\n" + "="*60)
    print("📊 SCÉNARIO 1: Trafic Normal")
    print("="*60)
    
    # Serveur avec capacité de 100 requêtes/seconde
    server = SimpleServer("ServeurWeb", capacity_rps=100)
    
    # Générer 50 requêtes normales
    normal_traffic = TrafficGenerator.generate_normal_traffic(50)
    
    print(f"\n→ Envoi de {len(normal_traffic)} requêtes normales...")
    
    for req in normal_traffic:
        result = server.receive_request(req)
        time.sleep(0.02)  # Simulation temps réel
    
    status = server.get_status()
    print(f"\n📈 Résultat:")
    print(f"   • Requêtes traitées: {status['processed']}")
    print(f"   • Requêtes rejetées: {status['dropped']}")
    print(f"   • Statut: {status['status']}")


def demo_ddos_attack():
    """Montre l'impact d'une attaque DDoS"""
    print("\n" + "="*60)
    print("🔴 SCÉNARIO 2: Attaque DDoS")
    print("="*60)
    
    # Même serveur
    server = SimpleServer("ServeurWeb", capacity_rps=100)
    
    # Mélange: trafic normal + attaque massive
    normal_traffic = TrafficGenerator.generate_normal_traffic(20)
    attack_traffic = TrafficGenerator.generate_ddos_attack(500)  # 500 requêtes d'attaque!
    
    # Mélanger le trafic
    all_traffic = normal_traffic + attack_traffic
    random.shuffle(all_traffic)
    
    print(f"\n→ Trafic total: {len(all_traffic)} requêtes")
    print(f"   • Normal: {len(normal_traffic)}")
    print(f"   • Attaque: {len(attack_traffic)}")
    print(f"\n→ Envoi du trafic...")
    
    normal_processed = 0
    attack_processed = 0
    
    for req in all_traffic:
        result = server.receive_request(req)
        if result:
            if req.request_type == "normal":
                normal_processed += 1
            else:
                attack_processed += 1
        time.sleep(0.001)
    
    status = server.get_status()
    print(f"\n📈 Résultat:")
    print(f"   • Requêtes normales traitées: {normal_processed}/{len(normal_traffic)}")
    print(f"   • Requêtes d'attaque traitées: {attack_processed}/{len(attack_traffic)}")
    print(f"   • Total rejeté: {status['dropped']}")
    print(f"   • Statut: {status['status']}")
    print(f"\n⚠️  Les utilisateurs légitimes ne peuvent plus accéder au service!")


# ============================================================
# PARTIE 5: Point d'entrée
# ============================================================

if __name__ == "__main__":
    print("""
    ╔═══════════════════════════════════════════════════════════╗
    ║           SHIELDNET - ÉTAPE 1: FONDAMENTAUX               ║
    ║           Comprendre les Attaques DDoS                    ║
    ╚═══════════════════════════════════════════════════════════╝
    """)
    
    demo_normal_traffic()
    demo_ddos_attack()
    
    print("\n" + "="*60)
    print("💡 LEÇON APPRISE:")
    print("="*60)
    print("""
    1. Un serveur a une CAPACITÉ LIMITÉE
    2. Une attaque DDoS DÉPASSE cette capacité
    3. Les utilisateurs légitimes sont IMPACTÉS
    
    → Solution: SCRUBBING CENTER pour filtrer le mauvais trafic
    → Encore mieux: COALITION pour partager les ressources!
    """)