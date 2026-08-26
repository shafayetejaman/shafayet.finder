import QtQuick
import qs.Commons
import qs.Ui

Row {
  id: tabsRoot

  signal tabSelected(string tab)

  property string activeTab: "all"
  property string fontFamily: Style.font.menuFamily
  property int captionSize: 12
  property int contentSize: 13

  readonly property var tabLabels: ({
    "all": "All",
    "folder": "Folder",
    "document": "Doc",
    "image": "Image",
    "music": "Music",
    "pdf": "PDF",
    "modified": "Modified",
    "created": "Created"
  })

  spacing: Style.space(4) + 2

  Repeater {
    model: ["all", "folder", "document", "image", "music", "pdf", "modified", "created"]

    Rectangle {
      id: chip
      required property string modelData
      required property int index

      width: chipLabel.implicitWidth + Style.space(16)
      height: tabsRoot.height
      radius: Style.cornerRadius
      color: chip.modelData === tabsRoot.activeTab
        ? Color.menu.selectedBackground
        : "transparent"
      border.width: 1
      border.color: chip.modelData === tabsRoot.activeTab
        ? Color.menu.selectedBackground
        : Color.menu.border

      Text {
        id: chipLabel
        anchors.centerIn: parent
        text: tabsRoot.tabLabels[chip.modelData] || chip.modelData
        textFormat: Text.PlainText
        color: chip.modelData === tabsRoot.activeTab
          ? Color.menu.selectedText
          : Color.menu.text
        opacity: chip.modelData === tabsRoot.activeTab ? 1 : 0.58
        font.family: tabsRoot.fontFamily
        font.pixelSize: tabsRoot.contentSize
      }

      MouseArea {
        anchors.fill: parent
        cursorShape: Qt.PointingHandCursor
        onClicked: tabsRoot.tabSelected(chip.modelData)
      }
    }
  }
}
